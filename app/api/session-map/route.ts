import { basename } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  listAllSessions,
  mergeSessionLists,
  resolveSessionPath,
} from "@/lib/session-reader";
import { getRpcSession, getRpcSessionInfos, getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { buildSessionMap, type SessionMapSource } from "@/lib/session-map";
import { workspaceKeyOf } from "@/lib/workspace-memory";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const activeSessionId = new URL(request.url).searchParams.get("sessionId")?.trim();
  if (!activeSessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    const [persisted, runtime] = await Promise.all([
      listAllSessions(),
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persisted, runtime);
    const activeSession = sessions.find((session) => session.id === activeSessionId);
    if (!activeSession) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const projectKey = workspaceKeyOf(activeSession);
    const projectSessions = sessions.filter((session) => workspaceKeyOf(session) === projectKey);
    const parentBySession = new Map<string, string>();
    for (const session of projectSessions) {
      if (session.parentSessionId) parentBySession.set(session.id, session.parentSessionId);
    }
    const limitedProjectSessions = [
      activeSession,
      ...projectSessions
        .filter((session) => session.id !== activeSessionId)
        .sort((a, b) => b.modified.localeCompare(a.modified)),
    ].slice(0, 80);
    const sources: SessionMapSource[] = [];

    for (const session of limitedProjectSessions) {
      try {
        const live = getRpcSession(session.id);
        const manager = live?.isAlive()
          ? live.inner.sessionManager
          : (() => {
              if (!session.path) return null;
              return SessionManager.open(session.path);
            })();
        if (!manager) continue;
        sources.push({
          session,
          entries: manager.getEntries() as never,
          leafId: manager.getLeafId(),
        });
      } catch {
        const filePath = session.path || await resolveSessionPath(session.id);
        if (!filePath) continue;
        try {
          const manager = SessionManager.open(filePath);
          sources.push({
            session,
            entries: manager.getEntries() as never,
            leafId: manager.getLeafId(),
          });
        } catch {
          // One malformed or concurrently removed session must not hide the map.
        }
      }
    }

    const graph = buildSessionMap(sources, activeSessionId, parentBySession);
    const projectRoot = activeSession.projectRoot ?? activeSession.cwd;
    return NextResponse.json({
      ...graph,
      truncated: graph.truncated || limitedProjectSessions.length < projectSessions.length,
      projectKey,
      projectRoot,
      projectTitle: basename(projectRoot) || projectRoot,
      sessions: limitedProjectSessions,
      runningSessionIds: getRunningRpcSessionIds().filter((id) => limitedProjectSessions.some((session) => session.id === id)),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
