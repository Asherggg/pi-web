import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { resolveSessionPath, readSessionHeader } from "@/lib/session-reader";
import { TurnSnapshotStore } from "@/lib/workbench/turn-snapshot-store";
import { TurnSnapshotError, validTurnSnapshotId, validTurnSnapshotSessionId } from "@/lib/workbench/turn-snapshot";
import { readSnapshotReviews, setSnapshotReviewed } from "@/lib/workbench/snapshot-review-store";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function failure(cause: unknown) {
  const value = cause as { code?: string; status?: number } | undefined;
  return NextResponse.json({ error: value?.code ?? "storage" }, { status: value?.status ?? 500, headers });
}
async function owned(sessionId: unknown, snapshotId: unknown) {
  if (!validTurnSnapshotSessionId(sessionId) || !validTurnSnapshotId(snapshotId)) throw new TurnSnapshotError("invalid");
  const path = await resolveSessionPath(sessionId);
  if (!path) throw new TurnSnapshotError("missing", 404);
  let header;
  try { header = readSessionHeader(path); } catch { throw new TurnSnapshotError("missing", 404); }
  if (!header || header.id !== sessionId) throw new TurnSnapshotError("missing", 404);
  if (header.version !== 3) throw new TurnSnapshotError("session-version-unavailable", 409);
  return new TurnSnapshotStore().detail(sessionId, snapshotId);
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "origin" }, { status: 403, headers });
  try {
    const query = new URL(request.url).searchParams;
    const detail = await owned(query.get("sessionId"), query.get("snapshotId"));
    return NextResponse.json({ paths: readSnapshotReviews(detail.sessionId, detail.snapshotId).filter((path) => detail.files.some((file) => file.path === path)) }, { headers });
  } catch (cause) { return failure(cause); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "origin" }, { status: 403, headers });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "content-type" }, { status: 415, headers });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 12000) throw new TurnSnapshotError("limit", 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new TurnSnapshotError("invalid"); }
    if (!body || typeof body.path !== "string" || typeof body.reviewed !== "boolean") throw new TurnSnapshotError("invalid");
    const detail = await owned(body.sessionId, body.snapshotId);
    if (!detail.files.some((file) => file.path === body.path)) throw new TurnSnapshotError("missing", 404);
    const paths = await setSnapshotReviewed(detail.sessionId, detail.snapshotId, body.path, body.reviewed);
    return NextResponse.json({ paths: paths.filter((path) => detail.files.some((file) => file.path === path)) }, { headers });
  } catch (cause) { return failure(cause); }
}
