import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { normalizeToolCalls } from "../normalize";
import { extractTurnWrittenFiles } from "../turn-written-files";
import { readSubagentRun, SUBAGENT_RESULT_TYPE, SUBAGENT_STATUS_TYPE } from "../subagents";
import type { AgentMessage, AssistantMessage, SessionEntry, ToolResultMessage } from "../types";
import { reportAdoptionKey, validSessionId, WorkbenchError, type ReportAdoption } from "./workflow";

export interface ReviewFile { path: string; state: "available" | "missing" | "outside" | "limit" | "changed"; hash?: string }
export interface ReportEvidence {
  parentSessionId: string; childSessionId: string; reportEntryId: string; resultEntryId: string;
  completedAt: string; status: string; text: string; error?: string; fingerprint: string;
  files: ReviewFile[]; adoption?: ReportAdoption; staleReview: boolean; latest: boolean; canReview: boolean; truncated: boolean;
}
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(content: unknown, max = 128 * 1024): string {
  if (typeof content === "string") return content.slice(0, max);
  return Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text.slice(0, max)).join("\n").slice(0, max) : "";
}
/** Exact structured metadata, never a child id guessed from prose or session titles. */
export function reportDetails(entry: SessionEntry): { details: Record<string, unknown>; content: unknown } | null {
  if (entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification" && entry.display !== false) {
    const details = record(entry.details); return details?.kind === "pi-web-subagent" ? { details, content: entry.content } : null;
  }
  if (entry.type === "message" && entry.message.role === "toolResult") {
    const message = entry.message; const details = record(message.details);
    return details?.kind === "pi-web-subagent" ? { details, content: message.content } : null;
  }
  return null;
}
export function reportChildId(entry: SessionEntry): string | null {
  const id = reportDetails(entry)?.details.sessionId;
  return validSessionId(id) ? id : null;
}
export function reportFiles(entries: SessionEntry[], resultIndex: number, cwd: string): ReviewFile[] {
  let start = 0;
  for (let i = resultIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "custom" && [SUBAGENT_RESULT_TYPE, SUBAGENT_STATUS_TYPE].includes(entry.customType)) { start = i + 1; break; }
  }
  const messages = entries.slice(start, resultIndex).flatMap((e) => e.type === "message" && e.message.role !== "system" ? [normalizeToolCalls(e.message as AgentMessage)] : []);
  const results = new Map(messages.filter((m): m is ToolResultMessage => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const paths = new Set(messages.filter((m): m is AssistantMessage => m.role === "assistant").flatMap((m) => extractTurnWrittenFiles(m.content, results, cwd).map((file) => file.filePath)));
  let budget = 32 * 1024 * 1024;
  return [...paths].slice(0, 100).map((path): ReviewFile => {
    let fd: number | undefined;
    try {
      const lexical = lstatSync(path);
      if (!lexical.isFile() || lexical.isSymbolicLink()) return { path, state: "outside" };
      const rel = relative(realpathSync(cwd), realpathSync(path));
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return { path, state: "outside" };
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const before = fstatSync(fd);
      if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino) return { path, state: "changed" };
      if (before.size > 8 * 1024 * 1024 || before.size > budget) return { path, state: "limit" };
      const data = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < data.length) { const count = readSync(fd, data, offset, data.length - offset, null); if (!count) break; offset += count; }
      const after = fstatSync(fd), current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { path, state: "changed" };
      budget -= offset;
      return { path, state: "available", hash: createHash("sha256").update(data.subarray(0, offset)).digest("hex") };
    } catch { return { path, state: "missing" }; }
    finally { if (fd !== undefined) closeSync(fd); }
  }).concat(paths.size > 100 ? [{ path: "", state: "limit" }] : []);
}
export function buildReportEvidence(input: {
  parentSessionId: string; childSessionId: string; reportEntryId: string;
  parentEntries: SessionEntry[]; childEntries: SessionEntry[]; childPath: string; cwd: string;
  busy: boolean; adoptions: Record<string, ReportAdoption>;
}): ReportEvidence {
  const report = input.parentEntries.find((entry) => entry.id === input.reportEntryId);
  if (!report) throw new WorkbenchError("missing", 404);
  const structured = reportDetails(report);
  if (!structured || structured.details.sessionId !== input.childSessionId) throw new WorkbenchError("reportMismatch", 409);
  const run = readSubagentRun(input.childEntries, input.childSessionId, input.childPath);
  if (!run || run.parentSessionId !== input.parentSessionId) throw new WorkbenchError("reportMismatch", 409);
  const completedAt = structured.details.completedAt;
  if (typeof completedAt !== "string") throw new WorkbenchError("reportUnavailable", 409);
  const resultIndexes = input.childEntries.flatMap((entry, index) => entry.type === "custom" && entry.customType === SUBAGENT_RESULT_TYPE && entry.id === structured.details.resultEntryId && record(entry.data)?.completedAt === completedAt ? [index] : []);
  if (!validSessionId(structured.details.resultEntryId) || resultIndexes.length !== 1) throw new WorkbenchError("reportUnavailable", 409);
  const resultIndex = resultIndexes[0];
  const result = input.childEntries[resultIndex];
  const data = result.type === "custom" ? record(result.data)! : {};
  if (data.version !== 1 || !["completed", "failed", "aborted"].includes(String(data.status)) || structured.details.status !== data.status) throw new WorkbenchError("reportMismatch", 409);
  const latest = !input.busy && run.resultEntryId === result.id && run.completedAt === completedAt && run.status === data.status;
  const files = reportFiles(input.childEntries, resultIndex, input.cwd);
  const rawText = typeof data.result === "string" ? data.result : text(structured.content);
  const truncated = rawText.length > 128 * 1024;
  const fingerprint = createHash("sha256").update(JSON.stringify({ report, result, files })).digest("hex");
  const adoption = input.adoptions[reportAdoptionKey(input.parentSessionId, input.reportEntryId)];
  const staleReview = Boolean(adoption && (adoption.fingerprint !== fingerprint || adoption.resultEntryId !== result.id || !latest));
  return { parentSessionId: input.parentSessionId, childSessionId: input.childSessionId, reportEntryId: report.id, resultEntryId: result.id, completedAt, status: String(data.status), text: rawText.slice(0, 128 * 1024), truncated, ...(typeof data.error === "string" ? { error: data.error.slice(0, 4000) } : {}), fingerprint, files, ...(adoption ? { adoption } : {}), staleReview, latest, canReview: latest };
}
