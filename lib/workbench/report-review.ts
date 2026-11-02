import { statSync } from "node:fs";
import { getRpcSession } from "../rpc-manager";
import { getLiveSubagentStatus } from "../subagent-runtime";
import { openSessionManager, resolveSessionPath } from "../session-reader";
import type { SessionEntry } from "../types";
import { buildReportEvidence } from "./report-evidence";
import { readWorkbenchState, updateWorkbenchState } from "./workflow-store";
import { validSessionId, WorkbenchError, type ReportAdoption } from "./workflow";

async function sessionReader(id: string) {
  const wrapper = getRpcSession(id);
  const path = wrapper?.isAlive() ? wrapper.sessionFile : await resolveSessionPath(id);
  if (!path) throw new WorkbenchError("missing", 404);
  return () => {
    const live = getRpcSession(id);
    if (!live?.isAlive() && statSync(path).size > 16 * 1024 * 1024) throw new WorkbenchError("historyTooLarge", 413);
    const manager = live?.isAlive() ? live.inner.sessionManager : openSessionManager(path);
    if (manager.getSessionId() !== id) throw new WorkbenchError("reportMismatch", 409);
    return { manager, path, busy: Boolean(live?.isRunning() || ["starting", "queued", "running"].includes(getLiveSubagentStatus(id) ?? "")) };
  };
}
export async function reportReader(parentSessionId: string, childSessionId: string, reportEntryId: string) {
  if (![parentSessionId, childSessionId, reportEntryId].every(validSessionId) || parentSessionId === childSessionId) throw new WorkbenchError("invalid");
  const [parent, child] = await Promise.all([sessionReader(parentSessionId), sessionReader(childSessionId)]);
  return () => {
    const parentView = parent(), childView = child();
    return buildReportEvidence({ parentSessionId, childSessionId, reportEntryId,
      parentEntries: parentView.manager.getEntries() as SessionEntry[], childEntries: childView.manager.getEntries() as SessionEntry[],
      childPath: childView.path, cwd: childView.manager.getCwd(), busy: childView.busy,
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
