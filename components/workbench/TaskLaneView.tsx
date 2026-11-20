"use client";
import { useMemo, useState } from "react";
import type { TaskLane, TaskNode } from "@/lib/workbench/graph";
import { currentTaskTurn, RECENT_TASK_TURNS, taskTurns, turnAnchorOwners, type TaskTreeRow } from "@/lib/workbench/task-tree-view";
import { compactToolTarget } from "@/lib/workbench/task-tool-summary";
import { taskLaneColor } from "@/hooks/task-light-anchors";
import { isHiddenRelation } from "@/lib/session-family";
import { useI18n } from "@/hooks/useI18n";

export function TaskLaneView({ lane, running, onOpen, onReview, onFork, onRefresh }: {
  lane: TaskLane; running: boolean;
  onOpen: (node: TaskNode) => void;
  onReview: (node: TaskNode) => void;
  onFork?: (node: TaskNode) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const turns = useMemo(() => taskTurns(lane), [lane]);
  const current = currentTaskTurn(turns);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [processChoices, setProcessChoices] = useState<Record<string, boolean>>({});
  const [fileChoices, setFileChoices] = useState<Record<string, boolean>>({});
  const [limit, setLimit] = useState(RECENT_TASK_TURNS);
  const visibleTurns = turns.filter((turn, index) => index >= turns.length - limit || running && turn.id === current);
  const hiddenCount = turns.length - visibleTurns.length;
  const session = lane.session;
  const state = running ? "running" : session.relation?.kind === "subagent" ? session.relation.status : "idle";
  const drawRow = (row: TaskTreeRow, live: boolean) => {
    const node = row.node;
    const pending = Boolean(row.operation && !row.settled);
    const executing = live && pending && node.active !== false;
    const label = row.operation ? t(`workbench.operation.${row.operation.action}`) : t(`workbench.${node.kind}`);
    const text = row.operation ? compactToolTarget(row.operation) || row.operation.name
      : node.filePath ? node.filePath.replace(/\\/g, "/").split("/").pop()! : node.text;
    const title = row.operation ? `${row.operation.name} ${row.operation.target}`.trim() : node.text;
    const status = node.error ? t("workbench.failed") : executing ? t("workbench.running")
      : row.operation ? t(row.settled ? "workbench.operation.done" : "workbench.operation.unsettled") : label;
    return <div key={row.id} data-task-node={row.id} data-task-row-kind={node.kind}
      className={`lancer-tree-node lancer-node-${node.kind}${node.error ? " lancer-node-error" : ""}${executing ? " lancer-node-executing" : ""}`}>
      <span className={`lancer-node-dot lancer-node-dot-${node.kind}`} data-task-light-target={row.id} aria-hidden="true" />
      <button type="button" onClick={() => onOpen(node)} title={title} aria-label={`${label}: ${text} · ${status}`}>
        <span className="lancer-node-status" aria-hidden="true">{node.error ? "!" : executing ? "◉" : row.settled ? "✓" : "·"}</span>
        <span className="lancer-node-kind">{label}</span>
        <span className="lancer-node-text">{text}</span>
        {row.operation?.edits && row.settled && !node.error && <small>{t("workbench.tree.edits", { count: row.operation.edits })}</small>}
      </button>
      {node.kind === "report" && node.reviewable && <button className={`lancer-review-button${node.staleReview ? " is-stale" : ""}`} type="button" onClick={() => onReview(node)}>{t(`workbench.review.${node.staleReview ? "stale" : node.adoption?.status ?? "pending"}`)}</button>}
    </div>;
  };
  return <section className="lancer-lane" data-task-lane={session.id} data-running={running} style={{ "--lancer-lane-color": taskLaneColor(session.id) } as React.CSSProperties}>
    <div className="lancer-lane-heading">
      {running && <svg className="light-running-border" style={{ "--light-color": taskLaneColor(session.id) } as React.CSSProperties} aria-hidden="true"><rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="5" pathLength="100" /></svg>}
      <strong title={session.name || session.firstMessage}>{session.name || session.firstMessage || session.id}</strong>
      <small>{t(`workbench.${state}`)}</small>
      {lane.model && <span className="lancer-lane-model-source" title={lane.model} data-workbench-lane-model={session.id}><span className="lancer-model-glyph" aria-hidden="true" /><span className="lancer-lane-model-name">{lane.model}</span></span>}
    </div>
    {lane.error && <p role="alert">{t(`workbench.${lane.error}`)} <button onClick={onRefresh}>{t("workbench.retry")}</button></p>}
    {!turns.length && !lane.error && <p className="lancer-help">{t("workbench.empty")}</p>}
    {hiddenCount > 0 && <button type="button" className="lancer-earlier-turns" data-task-earlier onClick={() => setLimit((value) => value + RECENT_TASK_TURNS)}>{t("workbench.tree.earlier", { count: hiddenCount })}</button>}
    {visibleTurns.map((turn) => {
      const live = running && turn.id === current;
      // Keep the newest round readable; every older round starts collapsed.
      // Explicit choices win across polling and live state changes.
      const open = choices[turn.id] ?? turn.id === current;
      const allProcess = processChoices[turn.id] ?? false;
      const process = open ? allProcess ? turn.process : live ? turn.process.slice(-3) : [] : [];
      const fileRows = turn.highlights.filter((row) => row.node.filePath);
      const highlights = turn.highlights.filter((row) => !row.node.filePath || fileChoices[turn.id] || fileRows.indexOf(row) < 3);
      const rows = open ? [...highlights, ...process] : [];
      const owners = turnAnchorOwners(turn, open, rows);
      const title = ["user", "report", "summary"].includes(turn.anchor.kind) ? turn.anchor.text : t("workbench.tree.context");
      const turnStatus = live ? t("workbench.running") : turn.error ? t("workbench.tree.hasErrors") : t("workbench.tree.recorded");
      return <section key={turn.id} className={`lancer-task-turn${live ? " is-running" : ""}`} data-task-turn={turn.id}>
        <div hidden aria-hidden="true">{[...owners].map(([id, target]) => <span key={id} data-task-anchor-for={id} data-task-anchor-id={target} />)}</div>
        <div className="lancer-turn-heading" data-task-node={turn.id}>
          <span className="lancer-node-dot" data-task-light-target={turn.id} aria-hidden="true" />
          <button type="button" data-task-turn-toggle aria-expanded={open} title={title} onClick={() => setChoices((old) => ({ ...old, [turn.id]: !open }))}>
            <span className="lancer-turn-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span className="lancer-turn-title">{title}</span>
            <small className={turn.error && !live ? "lancer-turn-issues" : ""}>{turnStatus}</small>
          </button>
          <button type="button" className="lancer-turn-locate" onClick={() => onOpen(turn.anchor)} title={t("workbench.tree.locate")} aria-label={`${t("workbench.tree.locate")}: ${title}`}>↗</button>
          {turn.anchor.kind === "user" && onFork && !isHiddenRelation(session.relation) && <button className="lancer-fork" type="button" aria-label={t("workbench.fork")} onClick={() => onFork(turn.anchor)}>⑂</button>}
        </div>
        <p className="lancer-turn-counts">{t("workbench.tree.turnCounts", { tools: turn.toolCount, files: turn.fileCount })}</p>
        {open && <div className="lancer-turn-body">
          {turn.process.length > 0 && <button type="button" className="lancer-process-toggle" data-task-process-toggle aria-expanded={allProcess} onClick={() => setProcessChoices((old) => ({ ...old, [turn.id]: !allProcess }))}>
            {t(allProcess ? "workbench.tree.hideProcess" : "workbench.tree.showProcess", { count: turn.process.length })}
          </button>}
          {process.map((row) => drawRow(row, live))}
          {highlights.map((row) => drawRow(row, live))}
          {fileRows.length > 3 && <button type="button" className="lancer-process-toggle" data-task-files-toggle aria-expanded={Boolean(fileChoices[turn.id])} onClick={() => setFileChoices((old) => ({ ...old, [turn.id]: !old[turn.id] }))}>{t(fileChoices[turn.id] ? "workbench.tree.hideFiles" : "workbench.tree.showFiles", { count: fileRows.length - 3 })}</button>}
        </div>}
      </section>;
    })}
  </section>;
}
