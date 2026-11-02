/** Public host extension identity, also used to refuse opt-in on a runtime created before recording support. */
export const TURN_SNAPSHOT_EXTENSION_NAME = "pi-web-turn-snapshots";
export const TURN_SNAPSHOT_EXTENSION_PATH = `<inline:${TURN_SNAPSHOT_EXTENSION_NAME}>`;
/** Auxiliary captures describe checkout changes during a run, never exclusive authorship. */
export type TurnSnapshotStatus = "open" | "completed" | "stopped" | "failed" | "unknown" | "interrupted";
export type TurnSnapshotAvailability = "complete" | "partial" | "unavailable";
export interface TurnSnapshotCoverage {
  state: TurnSnapshotAvailability;
  scope: "tracked-and-nonignored-untracked";
  notes: string[];
  omitted: Record<string, number>;
}
export interface TurnSnapshotCapture {
  state: TurnSnapshotAvailability;
  capturedAt: string;
  inventoryComplete: boolean;
  fileCount: number;
  byteCount: number;
  durationMs: number;
  coverage: TurnSnapshotCoverage;
}
export interface TurnSnapshotOverlap {
  snapshotId: string;
  sessionId: string;
  runId: string;
}
export interface TurnSnapshotSummary {
  snapshotId: string;
  sessionId: string;
  runId: string;
  runtimeId: string;
  checkoutPath: string;
  beforeEntryId: string | null;
  afterEntryId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: TurnSnapshotStatus;
  before: TurnSnapshotCapture;
  after: TurnSnapshotCapture | null;
  overlaps: TurnSnapshotOverlap[];
  /** Provenance keeps the first 64 overlaps; this count also includes any later overlaps. */
  overlapCount: number;
  coverage: TurnSnapshotCoverage;
}
export interface TurnSnapshotFile {
  path: string;
  kind: "added" | "modified" | "deleted";
  before: string | null;
  after: string | null;
}
export interface TurnSnapshotDetail extends TurnSnapshotSummary {
  files: TurnSnapshotFile[];
  response: { truncated: boolean; omittedFiles: number };
}
export interface TurnSnapshotList {
  enabled: boolean;
  /** Finished records only. An interrupted record has no usable final capture. */
  snapshots: TurnSnapshotSummary[];
}
export interface TurnSnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  timeoutMs: number;
  maxInventoryBytes: number;
  maxResponseBytes: number;
}
export const TURN_SNAPSHOT_LIMITS: TurnSnapshotLimits = {
  maxFiles: 2000,
  maxBytes: 8 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  timeoutMs: 3000,
  maxInventoryBytes: 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
};
export class TurnSnapshotError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
export function validTurnSnapshotSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
    && !["__proto__", "constructor", "prototype"].includes(id);
}
export function validTurnSnapshotId(id: unknown): id is string {
  return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
}
