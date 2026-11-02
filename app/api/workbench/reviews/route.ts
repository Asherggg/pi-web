import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { reportReader, saveReportReview } from "@/lib/workbench/report-review";
import { readWorkbenchState } from "@/lib/workbench/workflow-store";
import { WorkbenchError } from "@/lib/workbench/workflow";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
function failure(error: unknown) {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown } : {};
  const code = typeof value.code === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,80}$/.test(value.code) ? value.code : "storage";
  const status = Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599 ? Number(value.status) : 500;
  return NextResponse.json({ error: code }, { status, headers });
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  const query = new URL(request.url).searchParams;
  try {
    const read = await reportReader(query.get("parentSessionId") ?? "", query.get("childSessionId") ?? "", query.get("reportEntryId") ?? "");
    const state = readWorkbenchState();
    return NextResponse.json({ evidence: read(), revision: state.revision }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 12000) throw new WorkbenchError("limit", 413);
    let body;
    try { body = JSON.parse(raw); } catch { throw new WorkbenchError("invalid"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(body.fingerprint) || typeof body.resultEntryId !== "string" || !["reviewed", "accepted", "needs_changes", "rejected"].includes(body.status) || body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) throw new WorkbenchError("invalid");
    const result = await saveReportReview(body);
    return NextResponse.json(result, { headers });
  } catch (error) { return failure(error); }
}
