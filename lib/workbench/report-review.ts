import { lstatSync } from "node:fs";
import { getRpcSession } from "../rpc-manager";
import { getLiveSubagentStatus } from "../subagent-runtime";
import { readSessionHeader, openSessionManager, resolveSessionPath } from "../session-reader";
import type { SessionEntry } from "../types";
import { buildReportEvidence } from "./report-evidence";
import { readWorkbenchState, updateWorkbenchState } from "./workflow-store";
import { validSessionId, WorkbenchError, type ReportAdoption } from "./workflow";

const MAX_REVIEW_SESSION_BYTES = 16 * 1024 * 1024;
function readView(id: string, path: string, live = getRpcSession(id)) {
  if (live?.isAlive() && live.sessionFile === path) {
    if (live.inner.sessionManager.getSessionId() !== id) throw new WorkbenchError("missing", 404);
    return { manager: live.inner.sessionManager, path, cwd: live.cwd, busy: Boolean(live.isRunning() || ["starting", "queued", "running"].includes(getLiveSubagentStatus(id) ?? "")) };
  }
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkbenchError("missing", 404);
    if (stat.size > MAX_REVIEW_SESSION_BYTES) throw new WorkbenchError("historyTooLarge", 413);
    const header = readSessionHeader(path);
    if (!header || header.id !== id) throw new WorkbenchError("missing", 404);
    // SessionManager.open may migrate legacy JSONL. Review reads refuse old formats before opening.
    if (header.version !== 3) throw new WorkbenchError("sessionVersionUnavailable", 409);
    const manager = openSessionManager(path);
    if (manager.getSessionId() !== id || manager.getCwd() !== header.cwd) throw new WorkbenchError("missing", 404);
    return { manager, path, cwd: manager.getCwd(), busy: ["starting", "queued", "running"].includes(getLiveSubagentStatus(id) ?? "") };
  } catch (error) { if (error instanceof WorkbenchError) throw error; throw new WorkbenchError("missing", 404); }
}
async function sessionReader(id: string) {
  const live = getRpcSession(id);
  const path = live?.isAlive() ? live.sessionFile : await resolveSessionPath(id);
  if (!path) throw new WorkbenchError("missing", 404);
  readView(id, path, live);
  return () => readView(id, path);
}
export async function reportReader(parentSessionId: string, childSessionId: string, reportEntryId: string) {
  if (![parentSessionId, childSessionId, reportEntryId].every(validSessionId) || parentSessionId === childSessionId) throw new WorkbenchError("invalid");
  const [parent, child] = await Promise.all([sessionReader(parentSessionId), sessionReader(childSessionId)]);
  return () => {
    const parentView = parent(), childView = child();
    return buildReportEvidence({ parentSessionId, childSessionId, reportEntryId,
      parentEntries: parentView.manager.getEntries() as SessionEntry[], childEntries: childView.manager.getEntries() as SessionEntry[],
      childPath: childView.path, cwd: childView.cwd, busy: childView.busy,
      adoptions: readWorkbenchState().adoptions });
  };
}
export async function saveReportReview(input: {
  parentSessionId: string; childSessionId: string; reportEntryId: string; revision: number;
  resultEntryId: string; fingerprint: string; status: ReportAdoption["status"]; note?: string;
}) {
  const read = await reportReader(input.parentSessionId, input.childSessionId, input.reportEntryId);
  const verify = () => {
    const current = read();
    if (!current.latest || current.resultEntryId !== input.resultEntryId || current.fingerprint !== input.fingerprint) throw new WorkbenchError("reportChanged", 409);
    if (input.status === "accepted" && (current.status !== "completed" || current.truncated || current.files.some((file) => file.state !== "available"))) throw new WorkbenchError("reportNotAcceptable", 409);
  };
  verify();
  const state = await updateWorkbenchState({ type: "review-report", parentSessionId: input.parentSessionId, childSessionId: input.childSessionId, reportEntryId: input.reportEntryId, resultEntryId: input.resultEntryId, fingerprint: input.fingerprint, status: input.status, note: input.note }, input.revision, undefined, verify);
  return { revision: state.revision, evidence: read() };
}
