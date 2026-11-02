import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { serializeByKey } from "../key-serializer";
import { resolveExistingPath } from "../paths";
import {
  TURN_SNAPSHOT_LIMITS, TurnSnapshotError, validTurnSnapshotId, validTurnSnapshotSessionId,
  type TurnSnapshotCapture, type TurnSnapshotCoverage, type TurnSnapshotDetail, type TurnSnapshotFile,
  type TurnSnapshotLimits, type TurnSnapshotList, type TurnSnapshotStatus, type TurnSnapshotSummary,
} from "./turn-snapshot";
import {
  captureTurnSnapshot, emptyCoverage, isWithin, pathKey, safeSnapshotPath, snapshotCheckoutRoot, unavailableCapture,
  type SnapshotEntry, type SnapshotManifest,
} from "./turn-snapshot-capture";

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_OPEN_RECORDS = 64;
const OWNER_KEY = Symbol.for("pi-web:turn-snapshots-owner-v1");
const QUEUE_KEY = Symbol.for("pi-web:turn-snapshots-writes-v1");
interface Owner { id: string; pid: number }
function processOwner(): Owner {
  const global = globalThis as Record<symbol, unknown>;
  return (global[OWNER_KEY] ??= { id: randomUUID(), pid: process.pid }) as Owner;
}
interface StoredRecord extends Omit<TurnSnapshotSummary, "coverage"> { ownerId: string; ownerPid: number }
interface State { version: 1; enabledSessionIds: string[]; records: StoredRecord[] }
export interface TurnSnapshotOpening {
  sessionId: string;
  cwd: string;
  runtimeId: string;
  runId: string;
  beforeEntryId: string | null;
}
export interface TurnSnapshotHandle { snapshotId: string; sessionId: string; runtimeId: string; runId: string }
export interface TurnSnapshotStoreOptions {
  limits?: Partial<TurnSnapshotLimits>;
  retention?: { perSession?: number; overall?: number };
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
async function directory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TurnSnapshotError("storage-unsafe", 409);
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await chmod(path, 0o700);
    return true;
  } catch (error) { if (!create && isMissing(error)) return false; throw error; }
}
/** Bounded reads of private storage refuse links, FIFOs and inode replacement. */
export async function readTurnSnapshotFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  let before;
  try { before = await lstat(path); } catch (error) { if (isMissing(error)) return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new TurnSnapshotError("corrupt", 409);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new TurnSnapshotError("corrupt", 409);
    const chunks: Buffer[] = [];
    let size = 0;
    while (size <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead)); size += bytesRead;
    }
    if (size > maxBytes) throw new TurnSnapshotError("corrupt", 409);
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TurnSnapshotError("corrupt", 409);
  return value as Record<string, unknown>;
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) throw new TurnSnapshotError("corrupt", 409);
  return value;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw new TurnSnapshotError("corrupt", 409);
  return value;
}
function entryId(value: unknown): string | null { return value === null ? null : text(value, 256); }
function uuid(value: unknown): string {
  if (!validTurnSnapshotId(value)) throw new TurnSnapshotError("corrupt", 409);
  return value;
}
function sessionId(value: unknown): string {
  if (!validTurnSnapshotSessionId(value)) throw new TurnSnapshotError("invalid");
  return value;
}
function date(value: unknown): string {
  const date = text(value, 40);
  if (!Number.isFinite(Date.parse(date))) throw new TurnSnapshotError("corrupt", 409);
  return date;
}
function coverage(value: unknown): TurnSnapshotCoverage {
  const v = object(value);
  if (!["complete", "partial", "unavailable"].includes(String(v.state)) || v.scope !== "tracked-and-nonignored-untracked"
    || !Array.isArray(v.notes) || v.notes.length > 20) throw new TurnSnapshotError("corrupt", 409);
  const omitted: Record<string, number> = {};
  const omissions = object(v.omitted);
  if (Object.keys(omissions).length > 40) throw new TurnSnapshotError("corrupt", 409);
  for (const [key, count] of Object.entries(omissions)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) throw new TurnSnapshotError("corrupt", 409);
    omitted[key] = number(count);
  }
  if (v.state === "complete" && (v.notes.length || Object.keys(omitted).length)) throw new TurnSnapshotError("corrupt", 409);
  return { state: v.state as TurnSnapshotCoverage["state"], scope: v.scope, notes: v.notes.map((n) => text(n, 512)), omitted };
}
function capture(value: unknown): TurnSnapshotCapture {
  const v = object(value);
  const c = coverage(v.coverage);
  if (v.state !== c.state || typeof v.inventoryComplete !== "boolean" || (v.state === "complete" && !v.inventoryComplete)) throw new TurnSnapshotError("corrupt", 409);
  return {
    state: c.state, capturedAt: date(v.capturedAt), inventoryComplete: v.inventoryComplete,
    fileCount: number(v.fileCount, TURN_SNAPSHOT_LIMITS.maxFiles), byteCount: number(v.byteCount, TURN_SNAPSHOT_LIMITS.maxBytes),
    durationMs: number(v.durationMs), coverage: c,
  };
}
function decodeState(value: unknown): State {
  const v = object(value);
  if (v.version !== 1 || !Array.isArray(v.records) || v.records.length > 500 + MAX_OPEN_RECORDS
    || !Array.isArray(v.enabledSessionIds) || v.enabledSessionIds.length > 5000) throw new TurnSnapshotError("corrupt", 409);
  const records = v.records.map((raw): StoredRecord => {
    const r = object(raw);
    if (!["open", "completed", "stopped", "failed", "unknown", "interrupted"].includes(String(r.status))
      || !Array.isArray(r.overlaps) || r.overlaps.length > 64 || number(r.overlapCount) < r.overlaps.length) throw new TurnSnapshotError("corrupt", 409);
    const before = capture(r.before);
    const after = r.after === null ? null : capture(r.after);
    if (!isAbsolute(text(r.checkoutPath)) || number(r.ownerPid) < 1) throw new TurnSnapshotError("corrupt", 409);
    if ((r.status === "open" && (r.finishedAt !== null || after !== null))
      || (r.status !== "open" && r.status !== "interrupted" && r.finishedAt === null)
      || (["completed", "stopped", "failed", "unknown"].includes(String(r.status)) && after === null)) throw new TurnSnapshotError("corrupt", 409);
    return {
      snapshotId: uuid(r.snapshotId), sessionId: sessionId(r.sessionId), runId: uuid(r.runId), runtimeId: uuid(r.runtimeId),
      checkoutPath: text(r.checkoutPath), beforeEntryId: entryId(r.beforeEntryId), afterEntryId: entryId(r.afterEntryId),
      startedAt: date(r.startedAt), finishedAt: r.finishedAt === null ? null : date(r.finishedAt),
      status: r.status as TurnSnapshotStatus, before, after,
      ownerId: uuid(r.ownerId), ownerPid: number(r.ownerPid), overlapCount: number(r.overlapCount),
      overlaps: r.overlaps.map((raw) => { const o = object(raw); return { snapshotId: uuid(o.snapshotId), sessionId: sessionId(o.sessionId), runId: uuid(o.runId) }; }),
    };
  });
  if (new Set(records.map((r) => r.snapshotId)).size !== records.length) throw new TurnSnapshotError("corrupt", 409);
  const enabled = v.enabledSessionIds.map(sessionId);
  if (new Set(enabled).size !== enabled.length) throw new TurnSnapshotError("corrupt", 409);
  return { version: 1, enabledSessionIds: enabled, records };
}
function parse(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new TurnSnapshotError("corrupt", 409); }
}
function interrupted(record: StoredRecord): boolean {
  if (record.status !== "open") return false;
  const owner = processOwner();
  if (record.ownerPid === owner.pid) return record.ownerId !== owner.id;
  try { process.kill(record.ownerPid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === "ESRCH"; }
}
function displayRecord(stored: StoredRecord): StoredRecord {
  return interrupted(stored) ? { ...stored, status: "interrupted", finishedAt: null, after: null } : stored;
}
function summary(stored: StoredRecord): TurnSnapshotSummary {
  const r = displayRecord(stored);
  const result = emptyCoverage("complete");
  for (const c of [r.before, r.after]) {
    if (!c || c.state === "unavailable") result.state = "unavailable";
    else if (c.state === "partial" && result.state === "complete") result.state = "partial";
    if (c) {
      result.notes.push(...c.coverage.notes);
      for (const [key, count] of Object.entries(c.coverage.omitted)) result.omitted[key] = (result.omitted[key] ?? 0) + count;
    }
  }
  if (r.status === "open" || r.status === "interrupted") {
    result.state = "unavailable";
    result.notes.push(r.status === "open" ? "The final capture is pending." : "The recording was interrupted; no final capture is available.");
  } else if (r.status !== "completed") {
    if (result.state === "complete") result.state = "partial";
    result.notes.push(`This run ended with status ${r.status}.`);
  }
  if (r.overlapCount) {
    if (result.state === "complete") result.state = "partial";
    result.notes.push("Other recorded runs overlapped in this checkout. Changes cannot be attributed to this session alone.");
    if (r.overlapCount > r.overlaps.length) result.notes.push("Additional overlap provenance exceeded the 64-record display limit.");
  }
  result.notes = [...new Set(result.notes)];
  return {
    snapshotId: r.snapshotId, sessionId: r.sessionId, runId: r.runId, runtimeId: r.runtimeId,
    checkoutPath: r.checkoutPath, beforeEntryId: r.beforeEntryId, afterEntryId: r.afterEntryId,
    startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, before: r.before, after: r.after,
    overlaps: r.overlaps, overlapCount: r.overlapCount, coverage: result,
  };
}

/** Versioned private storage. All deletion targets are validated record IDs beneath this directory. */
export class TurnSnapshotStore {
  readonly directory: string;
  readonly limits: TurnSnapshotLimits;
  private readonly retention: { perSession: number; overall: number };
  constructor(agentDir = getAgentDir(), options: TurnSnapshotStoreOptions = {}) {
    this.directory = resolve(agentDir, "pi-web-turn-snapshots-v1");
    this.limits = { ...TURN_SNAPSHOT_LIMITS, ...options.limits };
    this.retention = { perSession: options.retention?.perSession ?? 50, overall: options.retention?.overall ?? 500 };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > TURN_SNAPSHOT_LIMITS[key as keyof TurnSnapshotLimits]) throw new TurnSnapshotError("invalid-limit");
    }
    if (this.limits.maxResponseBytes < 16 * 1024 || !Number.isSafeInteger(this.retention.perSession) || this.retention.perSession < 1 || this.retention.perSession > 50
      || !Number.isSafeInteger(this.retention.overall) || this.retention.overall < 1 || this.retention.overall > 500) throw new TurnSnapshotError("invalid-limit");
  }
  private async prepare(): Promise<void> {
    await directory(this.directory, true);
    await directory(join(this.directory, "records"), true);
    await directory(join(this.directory, "locks"), true);
  }
  private async state(): Promise<State> {
    if (!await directory(this.directory, false)) return { version: 1, enabledSessionIds: [], records: [] };
    const bytes = await readTurnSnapshotFile(join(this.directory, "state.json"), MAX_STATE_BYTES);
    if (!bytes) return { version: 1, enabledSessionIds: [], records: [] };
    try { return decodeState(parse(bytes)); }
    catch { throw new TurnSnapshotError("corrupt", 409); }
  }
  private async locked<T>(key: string, task: (assertLock: () => void) => Promise<T>): Promise<T> {
    await this.prepare();
    const lockPath = key === "state" ? join(this.directory, "state.json")
      : join(this.directory, "locks", createHash("sha256").update(key).digest("hex"));
    return serializeByKey(QUEUE_KEY, pathKey(lockPath), async () => {
      let compromised = false;
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(lockPath, {
          realpath: false, stale: 30_000, retries: { retries: 12, minTimeout: 25, maxTimeout: 250 },
          onCompromised: () => { compromised = true; },
        });
        const assertLock = () => { if (compromised) throw new TurnSnapshotError("locked", 409); };
        const result = await task(assertLock);
        assertLock();
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ELOCKED") throw new TurnSnapshotError("locked", 409);
        throw error;
      } finally { await release?.(); }
    });
  }
  private trimFinished(state: State): string[] {
    const perSession = new Map<string, number>();
    const dropped: string[] = [];
    let kept = 0;
    const finished = state.records.filter((r) => r.status !== "open")
      .sort((a, b) => (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt) || b.startedAt.localeCompare(a.startedAt) || b.snapshotId.localeCompare(a.snapshotId));
    for (const record of finished) {
      const count = (perSession.get(record.sessionId) ?? 0) + 1;
      perSession.set(record.sessionId, count);
      if (count > this.retention.perSession || kept >= this.retention.overall) dropped.push(record.snapshotId);
      else kept++;
    }
    const ids = new Set(dropped);
    state.records = state.records.filter((r) => !ids.has(r.snapshotId));
    return dropped;
  }
  private async update<T>(task: (state: State) => T | Promise<T>): Promise<T> {
    let dropped: string[] = [];
    const result = await this.locked("state", async (assertLock) => {
      const state = await this.state();
      state.records = state.records.map(displayRecord);
      const result = await task(state);
      // Recovery can turn open records into interrupted ones even on an opt-in write.
      dropped = this.trimFinished(state);
      decodeState(state);
      const bytes = JSON.stringify(state) + "\n";
      if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new TurnSnapshotError("limit", 413);
      assertLock();
      writePrivateFileAtomicSync(join(this.directory, "state.json"), bytes);
      return result;
    });
    // Publish retained references before deleting only validated, record-owned storage. Open records are never selected.
    for (const id of dropped) {
      const path = await this.recordDirectory(id).catch(() => null);
      if (path) await rm(path, { recursive: true, force: true });
    }
    return result;
  }
  private assertResolvedStorageOutside(checkoutPath: string): void {
    if (isWithin(resolveExistingPath(checkoutPath), resolveExistingPath(this.directory))) throw new TurnSnapshotError("storage-inside-checkout", 409);
  }
  async assertStorageOutside(cwd: string): Promise<void> {
    this.assertResolvedStorageOutside(await snapshotCheckoutRoot(cwd, 1500));
  }
  async isEnabled(id: string): Promise<boolean> { sessionId(id); return (await this.state()).enabledSessionIds.includes(id); }
  async setEnabled(id: string, enabled: boolean, beforeWrite?: () => void | Promise<void>): Promise<TurnSnapshotList> {
    sessionId(id);
    if (typeof enabled !== "boolean") throw new TurnSnapshotError("invalid");
    await this.update(async (state) => {
      await beforeWrite?.();
      state.enabledSessionIds = state.enabledSessionIds.filter((sid) => sid !== id);
      if (enabled) {
        if (state.enabledSessionIds.length >= 5000) throw new TurnSnapshotError("limit", 413);
        state.enabledSessionIds.push(id);
      }
    });
    return this.list(id);
  }
  async list(id: string): Promise<TurnSnapshotList> {
    sessionId(id);
    const state = await this.state();
    return { enabled: state.enabledSessionIds.includes(id), snapshots: state.records
      .filter((r) => r.sessionId === id).map(summary).filter((r) => r.status !== "open")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.snapshotId.localeCompare(a.snapshotId)) };
  }
  private async recordDirectory(id: string, create = false): Promise<string> {
    uuid(id);
    if (!await directory(this.directory, false) || !await directory(join(this.directory, "records"), false)) throw new TurnSnapshotError("snapshot-unavailable", 409);
    const path = join(this.directory, "records", id);
    if (!await directory(path, create)) throw new TurnSnapshotError("snapshot-unavailable", 409);
    return path;
  }
  private async capture(record: StoredRecord, phase: "before" | "after", signal?: AbortSignal): Promise<TurnSnapshotCapture> {
    const path = await this.recordDirectory(record.snapshotId, true);
    await directory(join(path, "blobs"), true);
    const storagePath = await realpath(this.directory);
    const result = isWithin(record.checkoutPath, storagePath)
      ? { capture: unavailableCapture("Snapshot storage is inside the checkout; recording is unavailable."), entries: [] }
      : await captureTurnSnapshot(record.checkoutPath, this.limits, async (hash, bytes) => {
        const blobPath = join(path, "blobs", `${hash}.gz`);
        try { await writeFile(blobPath, gzipSync(bytes), { flag: "wx", mode: 0o600, flush: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
      }, signal);
    const manifest: SnapshotManifest = { version: 1, snapshotId: record.snapshotId, phase, ...result };
    const bytes = JSON.stringify(manifest) + "\n";
    if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES) throw new TurnSnapshotError("limit", 413);
    // Each phase is written once. A replay cannot replace an original baseline or final capture.
    await writeFile(join(path, `${phase}.json`), bytes, { flag: "wx", mode: 0o600, flush: true });
    return result.capture;
  }
  async begin(input: TurnSnapshotOpening, signal?: AbortSignal): Promise<TurnSnapshotHandle | null> {
    sessionId(input.sessionId); uuid(input.runtimeId); uuid(input.runId); entryId(input.beforeEntryId);
    if (!await this.isEnabled(input.sessionId)) return null;
    const checkoutPath = await snapshotCheckoutRoot(input.cwd, 1500);
    this.assertResolvedStorageOutside(checkoutPath);
    return this.locked(`checkout:${pathKey(checkoutPath)}`, async () => {
      const owner = processOwner();
      const record: StoredRecord = {
        snapshotId: randomUUID(), sessionId: input.sessionId, runtimeId: input.runtimeId, runId: input.runId,
        checkoutPath, beforeEntryId: input.beforeEntryId, afterEntryId: null,
        startedAt: new Date().toISOString(), finishedAt: null, status: "open",
        before: unavailableCapture("The before capture did not finish."), after: null, overlaps: [], overlapCount: 0, ownerId: owner.id, ownerPid: owner.pid,
      };
      const admitted = await this.update((state) => {
        if (!state.enabledSessionIds.includes(input.sessionId)) return false;
        if (state.records.filter((r) => r.status === "open").length >= MAX_OPEN_RECORDS) throw new TurnSnapshotError("open-limit", 409);
        for (const other of state.records) {
          if (other.status !== "open" || pathKey(other.checkoutPath) !== pathKey(checkoutPath)) continue;
          record.overlapCount++;
          other.overlapCount++;
          if (record.overlaps.length < 64) record.overlaps.push({ snapshotId: other.snapshotId, sessionId: other.sessionId, runId: other.runId });
          if (other.overlaps.length < 64) other.overlaps.push({ snapshotId: record.snapshotId, sessionId: record.sessionId, runId: record.runId });
        }
        state.records.push(record); return true;
      });
      if (!admitted) return null;
      let before: TurnSnapshotCapture;
      try { before = await this.capture(record, "before", signal); }
      catch { before = unavailableCapture("The before capture could not be stored; this comparison is incomplete."); }
      try { await this.update((state) => { this.owned(state, record).before = before; }); }
      catch { /* Keep the handle so an awaited settlement can close this record if storage recovers. */ }
      return { snapshotId: record.snapshotId, sessionId: record.sessionId, runtimeId: record.runtimeId, runId: record.runId };
    });
  }
  private owned(state: State, handle: TurnSnapshotHandle): StoredRecord {
    const record = state.records.find((r) => r.snapshotId === handle.snapshotId);
    if (!record || record.sessionId !== handle.sessionId || record.runId !== handle.runId || record.runtimeId !== handle.runtimeId
      || record.ownerId !== processOwner().id || record.ownerPid !== process.pid || record.status !== "open") throw new TurnSnapshotError("snapshot-ownership", 409);
    return record;
  }
  async finish(handle: TurnSnapshotHandle, afterEntryId: string | null, status: Exclude<TurnSnapshotStatus, "open">): Promise<void> {
    uuid(handle.snapshotId); sessionId(handle.sessionId); uuid(handle.runId); uuid(handle.runtimeId); entryId(afterEntryId);
    if (!["completed", "stopped", "failed", "unknown", "interrupted"].includes(status)) throw new TurnSnapshotError("invalid");
    const initial = this.owned(await this.state(), handle);
    await this.locked(`checkout:${pathKey(initial.checkoutPath)}`, async () => {
      const record = this.owned(await this.state(), handle);
      // Shutdown/replacement does not establish a final settled boundary.
      let after: TurnSnapshotCapture | null = null;
      if (status !== "interrupted") {
        try { after = await this.capture(record, "after"); }
        catch { after = unavailableCapture("The final capture could not be stored; this comparison is incomplete."); }
      }
      await this.update((state) => {
        const current = this.owned(state, handle);
        Object.assign(current, { after, afterEntryId, status, finishedAt: new Date().toISOString() });
      });
    });
  }
  private async manifest(record: StoredRecord, phase: "before" | "after"): Promise<SnapshotManifest> {
    const path = await this.recordDirectory(record.snapshotId);
    const bytes = await readTurnSnapshotFile(join(path, `${phase}.json`), MAX_MANIFEST_BYTES);
    if (!bytes) throw new TurnSnapshotError("snapshot-unavailable", 409);
    const v = object(parse(bytes));
    if (v.version !== 1 || v.snapshotId !== record.snapshotId || v.phase !== phase || !Array.isArray(v.entries) || v.entries.length > this.limits.maxFiles) throw new TurnSnapshotError("corrupt", 409);
    const storedCapture = capture(v.capture);
    if (JSON.stringify(storedCapture) !== JSON.stringify(phase === "before" ? record.before : record.after)) throw new TurnSnapshotError("corrupt", 409);
    const entries = v.entries.map((raw): SnapshotEntry => {
      const e = object(raw);
      if (!safeSnapshotPath(e.path)) throw new TurnSnapshotError("corrupt", 409);
      if (e.state === "missing") return { path: e.path, state: "missing" };
      if (e.state === "omitted") return { path: e.path, state: "omitted", reason: text(e.reason, 64) };
      if (e.state !== "text" || typeof e.blob !== "string" || !/^[a-f0-9]{64}$/.test(e.blob) || typeof e.executable !== "boolean") throw new TurnSnapshotError("corrupt", 409);
      return { path: e.path, state: "text", blob: e.blob, size: number(e.size, this.limits.maxFileBytes), executable: e.executable };
    });
    let excludedPaths: string[] | undefined;
    if (v.excludedPaths !== undefined) {
      if (!Array.isArray(v.excludedPaths) || v.entries.length + v.excludedPaths.length > this.limits.maxFiles) throw new TurnSnapshotError("corrupt", 409);
      excludedPaths = v.excludedPaths.map((path) => {
        if (typeof path !== "string" || !safeSnapshotPath(path.endsWith("/") ? path.slice(0, -1) : path)) throw new TurnSnapshotError("corrupt", 409);
        return path;
      });
      if (new Set(excludedPaths).size !== excludedPaths.length) throw new TurnSnapshotError("corrupt", 409);
    }
    if (new Set(entries.map((e) => e.path)).size !== entries.length
      || entries.filter((e) => e.state === "text").length !== storedCapture.fileCount
      || entries.reduce((total, e) => total + (e.state === "text" ? e.size : 0), 0) !== storedCapture.byteCount) throw new TurnSnapshotError("corrupt", 409);
    return { version: 1, snapshotId: record.snapshotId, phase, capture: storedCapture, entries, excludedPaths };
  }
  private async content(id: string, entry: SnapshotEntry | undefined): Promise<string | null> {
    if (!entry || entry.state === "missing") return null;
    if (entry.state !== "text") throw new TurnSnapshotError("snapshot-unavailable", 409);
    const path = await this.recordDirectory(id);
    if (!await directory(join(path, "blobs"), false)) throw new TurnSnapshotError("snapshot-unavailable", 409);
    const stored = await readTurnSnapshotFile(join(path, "blobs", `${entry.blob}.gz`), this.limits.maxFileBytes + 4096);
    if (!stored) throw new TurnSnapshotError("snapshot-unavailable", 409);
    const bytes = gunzipSync(stored, { maxOutputLength: this.limits.maxFileBytes });
    if (bytes.length !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.blob
      || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new TurnSnapshotError("corrupt", 409);
    return bytes.toString("utf8");
  }
  async detail(id: string, snapshotId: string): Promise<TurnSnapshotDetail> {
    sessionId(id);
    if (!validTurnSnapshotId(snapshotId)) throw new TurnSnapshotError("invalid");
    // Serialize against retention, so an immutable detail is read with all its objects still retained.
    // Missing storage remains a read-only miss: GET does not initialize storage or an AgentSession.
    if (!await directory(this.directory, false)) throw new TurnSnapshotError("missing", 404);
    return this.locked("state", async () => {
      const record = (await this.state()).records.find((r) => r.snapshotId === snapshotId && r.sessionId === id);
      if (!record) throw new TurnSnapshotError("missing", 404);
      const result: TurnSnapshotDetail = { ...summary(record), files: [], response: { truncated: false, omittedFiles: 0 } };
      if (result.status === "open" || result.status === "interrupted" || result.coverage.state === "unavailable") return result;
      let before: SnapshotManifest; let after: SnapshotManifest;
      try { before = await this.manifest(record, "before"); after = await this.manifest(record, "after"); }
      catch {
        result.coverage = emptyCoverage("unavailable", "Stored snapshot data is missing or corrupt; the comparison is unavailable.");
        return result;
      }
      const left = new Map(before.entries.map((e) => [e.path, e]));
      const right = new Map(after.entries.map((e) => [e.path, e]));
      let remaining = this.limits.maxResponseBytes - Buffer.byteLength(JSON.stringify(result)) - 1024;
      for (const path of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        const b = left.get(path); const a = right.get(path);
        if (b?.state === "omitted" || a?.state === "omitted" || (!b && !before.capture.inventoryComplete) || (!a && !after.capture.inventoryComplete)) continue;
        // A complete ls-files inventory proves absence only outside its immutable ignored scope.
        // Older recordings lack that scope, so only explicit captured states can establish absence.
        const unknownScope = (manifest: SnapshotManifest) => manifest.excludedPaths === undefined
          || manifest.excludedPaths.some((excluded) => path === excluded || (excluded.endsWith("/") && path.startsWith(excluded)));
        if ((!b && unknownScope(before)) || (!a && unknownScope(after))) {
          result.coverage.state = "partial";
          result.coverage.omitted["excluded-scope"] = (result.coverage.omitted["excluded-scope"] ?? 0) + 1;
          continue;
        }
        const hasBefore = b?.state === "text"; const hasAfter = a?.state === "text";
        if ((!hasBefore && !hasAfter) || (hasBefore && hasAfter && b.blob === a.blob && b.executable === a.executable)) continue;
        let row: TurnSnapshotFile;
        try { row = { path, kind: !hasBefore ? "added" : !hasAfter ? "deleted" : "modified", before: await this.content(snapshotId, b), after: await this.content(snapshotId, a) }; }
        catch {
          result.response.omittedFiles++;
          result.coverage.state = "partial";
          result.coverage.omitted["blob-unavailable"] = (result.coverage.omitted["blob-unavailable"] ?? 0) + 1;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (size > remaining) { result.response.omittedFiles++; result.response.truncated = true; continue; }
        remaining -= size; result.files.push(row);
      }
      if (result.response.truncated) {
        result.coverage.state = "partial";
        result.coverage.notes.push("The response byte limit omitted some changed files.");
      }
      if (result.coverage.omitted["excluded-scope"]) result.coverage.notes.push("Files excluded or with unknown ignore coverage in either capture were omitted from the comparison.");
      if (result.coverage.omitted["blob-unavailable"]) result.coverage.notes.push("Some stored contents are missing or corrupt and were omitted.");
      return result;
    });
  }
}
