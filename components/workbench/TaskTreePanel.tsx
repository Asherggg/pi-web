"use client";
import { useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { TaskGraph, TaskNode, TaskScope } from "@/lib/workbench/graph";
import { useI18n } from "@/hooks/useI18n";
import "@/lib/vendor/lancer-light-ui/running-border.css";
export function TaskTreePanel({ graph, loading, error, scope, onScope, onRefresh, onClose, onNavigate, onFork, onOpenFile, onFullMap }: {
  graph: TaskGraph | null; loading: boolean; error: string | null; scope: TaskScope; onScope: (scope: TaskScope) => void;
  onRefresh: () => void; onClose: () => void; onNavigate?: (session: SessionInfo, entryId: string, navigateBranch: boolean) => Promise<void>;
  onFork?: (session: SessionInfo, entryId: string) => Promise<void>; onOpenFile?: (path: string) => void; onFullMap?: () => void;
}) {
  const { t } = useI18n();
  const [actionError, setActionError] = useState<string | null>(null);
  const files = graph?.lanes.flatMap((lane) => lane.nodes.filter((n) => n.kind === "file")) ?? [];
  const fileMap = new Map(files.map((file) => [file.filePath!, file]));
  const openNode = (node: TaskNode, session: SessionInfo) => {
    setActionError(null);
    if (node.filePath) onOpenFile?.(node.filePath);
    else void onNavigate?.(session, node.entryId, node.active === false).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  };
  return <aside id="lancer-task-tree" className="lancer-tree" aria-label={t("workbench.title")}>
    <header><strong>{t("workbench.tree")}</strong><span><button type="button" onClick={onRefresh} aria-label={t("workbench.refresh")}>↻</button><button type="button" onClick={onClose} aria-label={t("workbench.close")}>×</button></span></header>
    <div className="lancer-tree-controls"><select aria-label={t("workbench.tree")} value={scope} onChange={(e) => onScope(e.target.value as TaskScope)}>{(["current", "family", "project"] as const).map((s) => <option value={s} key={s}>{t(`workbench.${s}`)}</option>)}</select>{onFullMap && <button type="button" onClick={onFullMap}>{t("workbench.fullMap")}</button>}</div>
    {actionError && <p role="alert">{actionError}</p>}
    {error && <p role="alert">{t(`workbench.${error}`)} <button onClick={onRefresh}>{t("workbench.retry")}</button></p>}
    {loading && !graph && <p role="status">{t("chat.loadingSession")}</p>}
    <div className="lancer-tree-scroll">
      <div className="lancer-lanes">{graph?.lanes.map((lane) => {
        const session = lane.session;
        const state = graph.running.includes(session.id) ? "running" : session.relation?.kind === "subagent" ? session.relation.status : "idle";
        const known = new Set(lane.nodes.map((n) => n.id));
        const children = new Map<string, number>();
        for (const node of lane.nodes) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
        const depths = new Map<string, number>();
        return <section key={session.id} className="lancer-lane" data-running={state === "running"}>
          <div className="lancer-lane-heading">{state === "running" && <svg className="light-running-border" style={{ "--light-color": "var(--accent)" } as React.CSSProperties} aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="5" pathLength="100" /></svg>}<strong title={session.name || session.firstMessage}>{session.name || session.firstMessage || session.id}</strong><small>{t(`workbench.${state}`)}</small>{lane.model && <small title={lane.model}>{lane.model}</small>}{session.parentSessionId && <small title={session.parentSessionId}>{t("workbench.parent")}: {graph.lanes.find((l) => l.session.id === session.parentSessionId)?.session.name || session.parentSessionId.slice(0, 8)}</small>}</div>
          {lane.error && <p role="alert">{t(`workbench.${lane.error}`)} <button onClick={onRefresh}>{t("workbench.retry")}</button></p>}
          {!lane.nodes.length && !lane.error && <p className="lancer-help">{t("workbench.empty")}</p>}
          {lane.nodes.map((node) => {
            const depth = node.parentId && known.has(node.parentId) ? Math.min(4, (depths.get(node.parentId) ?? 0) + ((children.get(node.parentId) ?? 0) > 1 ? 1 : 0)) : 0;
            depths.set(node.id, depth);
            return <div key={node.id} data-task-node={node.id} className={`lancer-tree-node lancer-node-${node.kind}${node.error ? " lancer-node-error" : ""}${node.active ? " lancer-node-active" : ""}`} style={{ marginLeft: depth * 14 }}>
              <button type="button" onClick={() => openNode(node, session)} title={node.text}><span className="lancer-node-kind">{t(`workbench.${node.kind}`)}{node.error ? ` · ${t("workbench.failed")}` : ""}</span><span className="lancer-node-text">{node.text}</span></button>
              {node.kind === "user" && onFork && session.relation?.kind !== "subagent" && <button className="lancer-fork" title={t("workbench.fork")} aria-label={t("workbench.fork")} onClick={() => { void onFork(session, node.entryId).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error))); }}>⑂</button>}
            </div>;
          })}
        </section>;
      })}</div>
      {graph?.truncated && <p className="lancer-help">{t("workbench.truncated")}</p>}
      <section className="lancer-deliverables"><h3>{t("workbench.files")}</h3>{!files.length && <p className="lancer-help">{t("workbench.noFiles")}</p>}{[...fileMap.values()].map((file) => <button type="button" key={file.id} onClick={() => onOpenFile?.(file.filePath!)} title={file.filePath}>{file.filePath?.replace(/\\/g, "/").split("/").pop()}</button>)}</section>
    </div>
  </aside>;
}
