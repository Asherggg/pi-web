import { NextResponse } from "next/server";
import { statSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { attachSessionProjectInfo, listAllSessions, mergeSessionLists, openSessionManager } from "@/lib/session-reader";
import { getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds, subagentDisplayStatus } from "@/lib/rpc-manager";
import { getSessionSettings } from "@/lib/session-reader";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import type { SessionEntry } from "@/lib/types";
import { buildTaskLane, familySessionIds, type TaskLane, type TaskScope } from "@/lib/workbench/graph";
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
    let remaining = 1200;
    for (const session of selected.slice(0, 40)) {
      if (request.signal.aborted) break;
      if (remaining <= 0) break;
      try {
        // Read-only observers must never create an AgentSession or prompt a model.
        const wrapper = getRpcSession(session.id);
        if (!wrapper?.isAlive() && statSync(session.path).size > 16 * 1024 * 1024) {
          lanes.push({ session, nodes: [], error: "historyTooLarge", truncated: true }); continue;
        }
        const manager = wrapper?.isAlive() ? wrapper.inner.sessionManager : openSessionManager(session.path);
        const entries = manager.getEntries() as SessionEntry[];
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
    return NextResponse.json({ sessionId: id, lanes, running: getRunningRpcSessionIds().filter((sid) => selected.some((s) => s.id === sid)), truncated: lanes.length < selected.length || lanes.some((l) => l.truncated) }, { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "historyError" }, { status: 500 }); }
}
