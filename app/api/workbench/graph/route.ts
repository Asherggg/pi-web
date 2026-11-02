import { NextResponse } from "next/server";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { attachSessionProjectInfo, listAllSessions, mergeSessionLists, openSessionManager } from "@/lib/session-reader";
import { getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds, subagentDisplayStatus } from "@/lib/rpc-manager";
import { getSessionSettings, readSessionHeader } from "@/lib/session-reader";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import type { SessionEntry } from "@/lib/types";
import { buildTaskLane, buildTaskLineageEdges, familySessionIds, type TaskLane, type TaskScope } from "@/lib/workbench/graph";
import { readSubagentRun } from "@/lib/subagents";
import { buildReportEvidence } from "@/lib/workbench/report-evidence";
import { readWorkbenchState } from "@/lib/workbench/workflow-store";
import { reportAdoptionKey } from "@/lib/workbench/workflow";
import { validSessionId } from "@/lib/workbench/workflow";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("sessionId");
  const scope = (url.searchParams.get("scope") ?? "family") as TaskScope;
  if (!validSessionId(id) || !["current", "family", "project"].includes(scope)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const [disk, live] = await Promise.all([listAllSessions(), attachSessionProjectInfo(getRpcSessionInfos())]);
    const sessions = mergeSessionLists(disk, live).map((session) => session.relation?.kind === "subagent" ? {
      ...session, relation: { ...session.relation, status: subagentDisplayStatus(session.id, session.relation.status) },
    } : session);
    const active = sessions.find((s) => s.id === id);
    if (!active) return NextResponse.json({ error: "missing" }, { status: 404 });
    const family = familySessionIds(sessions, id);
    const selected = sessions.filter((s) => scope === "current" ? s.id === id : scope === "family" ? family.has(s.id) : workspaceKeyOf(s) === workspaceKeyOf(active));
    selected.sort((a, b) => a.id === id ? -1 : b.id === id ? 1 : b.modified.localeCompare(a.modified));
    const lanes: TaskLane[] = [];
    const sources = new Map<string, { entries: SessionEntry[]; path: string; cwd: string }>();
    let remaining = 1200;
    for (const session of selected.slice(0, 40)) {
      if (request.signal.aborted) break;
      if (remaining <= 0) break;
      try {
        // Read-only observers must never create an AgentSession or prompt a model.
        const wrapper = getRpcSession(session.id);
        if (!wrapper?.isAlive()) {
          const stats = lstatSync(session.path);
          if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("history-unavailable");
          if (stats.size > 16 * 1024 * 1024) {
            lanes.push({ session, nodes: [], error: "historyTooLarge", truncated: true }); continue;
          }
          const header = readSessionHeader(session.path);
          if (!header || header.id !== session.id || header.version !== 3) {
            lanes.push({ session, nodes: [], error: "sessionVersionUnavailable", truncated: false }); continue;
          }
        }
        const manager = wrapper?.isAlive() ? wrapper.inner.sessionManager : openSessionManager(session.path);
        const entries = manager.getEntries() as SessionEntry[];
        sources.set(session.id, { entries, path: manager.getSessionFile() ?? session.path, cwd: session.cwd });
        const lane = buildTaskLane(session, entries, Math.min(300, remaining));
        const model = getSessionSettings(entries, manager.getLeafId()).model;
        lane.model = model ? `${model.provider}/${model.modelId}` : undefined;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        const activeIds = new Set<string>();
        let cursor = manager.getLeafId();
        while (cursor && !activeIds.has(cursor)) {
          activeIds.add(cursor);
          cursor = byId.get(cursor)?.parentId ?? null;
        }
        for (const node of lane.nodes) node.active = activeIds.has(node.entryId);
        // File links represent successful writes that are still regular files in this checkout.
        lane.nodes = lane.nodes.filter((node) => {
          if (!node.filePath) return true;
          try {
            const rel = relative(realpathSync(session.cwd), realpathSync(node.filePath));
            return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel) && statSync(node.filePath).isFile();
          } catch { return false; }
        });
        remaining -= lane.nodes.length;
        lanes.push(lane);
      } catch { lanes.push({ session, nodes: [], error: "historyError", truncated: false }); }
    }
    let reviewsError: string | undefined;
    let adoptions: ReturnType<typeof readWorkbenchState>["adoptions"] = {};
    try { adoptions = readWorkbenchState().adoptions; } catch { reviewsError = "corrupt"; }
    const childRuns = [...sources].flatMap(([childSessionId, source]) => {
      const run = readSubagentRun(source.entries, childSessionId, source.path);
      return run ? [{ childSessionId, parentSessionId: run.parentSessionId, parentToolCallId: run.parentToolCallId }] : [];
    });
    for (const lane of lanes) for (const node of lane.nodes) {
      if (node.kind !== "report" || !node.childSessionId || !node.reportEntryId) continue;
      const parent = sources.get(lane.session.id), child = sources.get(node.childSessionId);
      if (!parent || !child) { node.reviewable = false; continue; }
      node.reviewError = "reportUnavailable";
      try {
        const evidence = buildReportEvidence({ parentSessionId: lane.session.id, childSessionId: node.childSessionId, reportEntryId: node.reportEntryId, parentEntries: parent.entries, childEntries: child.entries, childPath: child.path, cwd: child.cwd, busy: Boolean(getRpcSession(node.childSessionId)?.isRunning()), adoptions });
        node.resultEntryId = evidence.resultEntryId;
        node.completedAt = evidence.completedAt;
        node.reviewable = evidence.canReview;
        node.reviewError = evidence.canReview ? undefined : "reportUnavailable";
        const saved = adoptions[reportAdoptionKey(lane.session.id, node.reportEntryId)];
        node.staleReview = evidence.staleReview;
        node.adoption = saved && !evidence.staleReview ? saved : undefined;
      } catch { node.reviewable = false; node.reviewError = "reportUnavailable"; }
    }
    const edges = buildTaskLineageEdges(lanes, childRuns);
    return NextResponse.json({ sessionId: id, lanes, edges, reviewsError, running: getRunningRpcSessionIds().filter((sid) => selected.some((s) => s.id === sid)), truncated: lanes.length < selected.length || lanes.some((l) => l.truncated) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "historyError" }, { status: 500 }); }
}
