import { NextResponse } from "next/server";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getRpcSession } from "@/lib/rpc-manager";
import { openSessionManager, resolveSessionPath } from "@/lib/session-reader";
import { hasJsonContentType, isApiRequestOriginAllowed } from "@/lib/request-security";
import { TURN_SNAPSHOT_EXTENSION_PATH, TurnSnapshotError, validTurnSnapshotSessionId, validTurnSnapshotId } from "@/lib/workbench/turn-snapshot";
import { TurnSnapshotStore } from "@/lib/workbench/turn-snapshot-store";

export const dynamic = "force-dynamic";
const store = new TurnSnapshotStore();
const MAX_REQUEST_BYTES = 16 * 1024;
interface SavedSession { cwd: string; path: string }
async function resolveSavedSession(id: string): Promise<SavedSession> {
  let path: string | undefined;
  const live = getRpcSession(id);
  if (live?.isAlive()) path = live.sessionFile || undefined;
  else path = await resolveSessionPath(id) ?? undefined;
  if (!path || !isAbsolute(path)) throw new TurnSnapshotError("missing", 404);
  let stat;
  try { stat = await lstat(path); } catch { throw new TurnSnapshotError("missing", 404); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TurnSnapshotError("missing", 404);
  if (stat.size > 16 * 1024 * 1024 && !live?.isAlive()) throw new TurnSnapshotError("session-too-large", 413);
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let header;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new TurnSnapshotError("missing", 404);
      const bytes = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const line = bytes.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]!;
      header = JSON.parse(line);
    } finally { await handle.close(); }
    if (header.type !== "session" || header.id !== id || !isAbsolute(header.cwd)) throw new TurnSnapshotError("missing", 404);
    // SDK open-time migration writes legacy JSONL. Refuse that here so browsing snapshots never rewrites a transcript.
    if (header.version !== 3) throw new TurnSnapshotError("session-version-unavailable", 409);
    const manager = live?.isAlive() && live.sessionFile === path ? live.inner.sessionManager : openSessionManager(path);
    if (manager.getSessionId() !== id || resolve(manager.getCwd()) !== resolve(header.cwd)) throw new TurnSnapshotError("missing", 404);
    return { cwd: manager.getCwd(), path };
  } catch (error) {
    if (error instanceof TurnSnapshotError) throw error;
    throw new TurnSnapshotError("missing", 404);
  }
}
function failure(error: unknown) {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown } : undefined;
  const known = value && typeof value.code === "string" && typeof value.status === "number" ? { code: value.code, status: value.status } : null;
  return NextResponse.json({ error: known?.code ?? "storage" }, { status: known?.status ?? 500, headers: { "Cache-Control": "no-store" } });
}
function checkRecordingRuntime(id: string): void {
  const live = getRpcSession(id);
  const loader = live?.inner.resourceLoader as { getExtensions?: () => { extensions: Array<{ path: string }> } } | undefined;
  if (live?.isAlive() && !loader?.getExtensions?.().extensions.some((extension) => extension.path === TURN_SNAPSHOT_EXTENSION_PATH)) {
    throw new TurnSnapshotError("recording-runtime-unavailable", 409);
  }
}
function checkOrigin(request: Request): void {
  if (request.headers.get("sec-fetch-site") === "same-site" || !isApiRequestOriginAllowed(request)) throw new TurnSnapshotError("origin", 403);
}
async function readRequestBody(request: Request): Promise<unknown> {
  if (!hasJsonContentType(request)) throw new TurnSnapshotError("content-type", 415);
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) throw new TurnSnapshotError("limit", 413);
  const body = await readRequestBytes(request);
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); } catch { throw new TurnSnapshotError("invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TurnSnapshotError("invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["sessionId", "action", "enabled"].includes(key))
    || record.action !== "set-enabled" || typeof record.enabled !== "boolean" || !validTurnSnapshotSessionId(record.sessionId)) {
    throw new TurnSnapshotError("invalid");
  }
  return record;
}
async function readRequestBytes(request: Request): Promise<Buffer> {
  if (!request.body) throw new TurnSnapshotError("invalid");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new TurnSnapshotError("limit", 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}
export async function GET(request: Request) {
  try {
    checkOrigin(request);
    const url = new URL(request.url);
    if (url.searchParams.getAll("sessionId").length !== 1) throw new TurnSnapshotError("invalid");
    const id = url.searchParams.get("sessionId");
    if (!validTurnSnapshotSessionId(id)) throw new TurnSnapshotError("invalid");
    const snapshotIds = url.searchParams.getAll("snapshotId");
    if (snapshotIds.length > 1 || (snapshotIds.length === 1 && !validTurnSnapshotId(snapshotIds[0]))) throw new TurnSnapshotError("invalid");
    await resolveSavedSession(id);
    const result = snapshotIds.length ? await store.detail(id, snapshotIds[0]!) : await store.list(id);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const body = await readRequestBody(request) as { sessionId: string; enabled: boolean };
    const session = await resolveSavedSession(body.sessionId);
    if (body.enabled) {
      checkRecordingRuntime(body.sessionId);
      await store.assertStorageOutside(session.cwd);
    }
    const result = await store.setEnabled(body.sessionId, body.enabled, async () => {
      // Revalidate after queued/cross-process lock waits; stale JSONL sessions must not be re-enabled.
      const latest = await resolveSavedSession(body.sessionId);
      if (resolve(latest.path) !== resolve(session.path)) throw new TurnSnapshotError("missing", 404);
      if (body.enabled) {
        checkRecordingRuntime(body.sessionId);
        await store.assertStorageOutside(latest.cwd);
      }
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
