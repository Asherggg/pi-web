import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readRegularFileText } from "../regular-file";
import { serializeByKey } from "../key-serializer";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { TurnSnapshotError, validTurnSnapshotId, validTurnSnapshotSessionId } from "./turn-snapshot";
interface Mark { sessionId: string; snapshotId: string; path: string; reviewedAt: string }
interface State { version: 1; marks: Record<string, Mark> }
const pathFor = () => join(getAgentDir(), "pi-web-snapshot-reviews.json");
const keyFor = (sessionId: string, snapshotId: string, path: string) => createHash("sha256").update(JSON.stringify([sessionId, snapshotId, path])).digest("hex");
function decode(raw: unknown): State {
  if (!raw || typeof raw !== "object" || (raw as State).version !== 1 || !(raw as State).marks || typeof (raw as State).marks !== "object" || Array.isArray((raw as State).marks)) throw new TurnSnapshotError("corrupt", 409);
  const marks: Record<string, Mark> = Object.create(null);
  const entries = Object.entries((raw as State).marks);
  if (entries.length > 5000) throw new TurnSnapshotError("limit", 413);
  for (const [key, value] of entries) {
    if (!value || !validTurnSnapshotSessionId(value.sessionId) || !validTurnSnapshotId(value.snapshotId) || typeof value.path !== "string" || value.path.length > 4096 || key !== keyFor(value.sessionId, value.snapshotId, value.path) || typeof value.reviewedAt !== "string" || !Number.isFinite(Date.parse(value.reviewedAt))) throw new TurnSnapshotError("corrupt", 409);
    marks[key] = value;
  }
  return { version: 1, marks };
}
function read(path: string): State {
  const text = readRegularFileText(path, 4 * 1024 * 1024);
  if (text === undefined) return { version: 1, marks: Object.create(null) };
  try { return decode(JSON.parse(text)); } catch { throw new TurnSnapshotError("corrupt", 409); }
}
export function readSnapshotReviews(sessionId: string, snapshotId: string, path = pathFor()): string[] {
  return Object.values(read(path).marks).filter((mark) => mark.sessionId === sessionId && mark.snapshotId === snapshotId).map((mark) => mark.path);
}
export async function setSnapshotReviewed(sessionId: string, snapshotId: string, filePath: string, reviewed: boolean, path = pathFor()): Promise<string[]> {
  if (!validTurnSnapshotSessionId(sessionId) || !validTurnSnapshotId(snapshotId) || !filePath || filePath.length > 4096 || typeof reviewed !== "boolean") throw new TurnSnapshotError("invalid");
  return serializeByKey(Symbol.for("pi-web:snapshot-file-review"), path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let compromised = false;
    const release = await lockfile.lock(path, { realpath: false, retries: { retries: 10, minTimeout: 25, maxTimeout: 250 }, onCompromised: () => { compromised = true; } });
    try {
      const current = read(path);
      const key = keyFor(sessionId, snapshotId, filePath);
      if (reviewed) current.marks[key] = { sessionId, snapshotId, path: filePath, reviewedAt: new Date().toISOString() };
      else delete current.marks[key];
      const ordered = Object.entries(current.marks).sort((a, b) => b[1].reviewedAt.localeCompare(a[1].reviewedAt));
      current.marks = Object.fromEntries(ordered.slice(0, 5000));
      const text = JSON.stringify(current) + "\n";
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new TurnSnapshotError("limit", 413);
      if (compromised) throw new TurnSnapshotError("locked", 409);
      writePrivateFileAtomicSync(path, text);
      return Object.values(current.marks).filter((mark) => mark.sessionId === sessionId && mark.snapshotId === snapshotId).map((mark) => mark.path);
    } finally { await release(); }
  });
}
