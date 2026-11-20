"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskLaneView } from "./TaskLaneView";
import { taskTurns } from "@/lib/workbench/task-tree-view";
import { TaskLineageOverlay } from "./TaskLineageOverlay";
import { TurnSnapshotPanel } from "./TurnSnapshotPanel";
import type { SessionInfo } from "@/lib/types";
import type { TaskGraph, TaskLane, TaskNode, TaskScope } from "@/lib/workbench/graph";
import type { ReportAdoptionStatus } from "@/lib/workbench/workflow";
import type { ReportEvidence } from "@/lib/workbench/report-evidence";
import { useI18n } from "@/hooks/useI18n";
import "@/lib/vendor/lancer-light-ui/running-border.css";

interface ReviewTarget { parentSessionId: string; childSessionId: string; evidence: ReportEvidence; revision: number }
export function TaskTreePanel({ graph, loading, error, scope, onScope, onRefresh, onClose, onNavigate, onFork, onOpenFile, onFullMap }: {
  graph: TaskGraph | null; loading: boolean; error: string | null; scope: TaskScope; onScope: (scope: TaskScope) => void;
  onRefresh: () => void; onClose: () => void;
  onNavigate?: (session: SessionInfo, entryId: string, navigateBranch: boolean) => Promise<void>;
  onFork?: (session: SessionInfo, entryId: string) => Promise<void>; onOpenFile?: (path: string) => void; onFullMap?: () => void;
}) {
  const { t } = useI18n();
  const lanesRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const counts = useMemo(() => {
    const turns = graph?.lanes.flatMap(taskTurns) ?? [];
    return { turns: turns.length, tools: turns.reduce((sum, turn) => sum + turn.toolCount, 0), files: new Set(graph?.lanes.flatMap((lane) => lane.nodes.filter((node) => node.filePath).map((node) => node.filePath))).size };
  }, [graph]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewTarget | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const reviewGeneration = useRef(0);
  const invalidateReview = useCallback(() => { reviewGeneration.current++; }, []);
  useEffect(() => {
    invalidateReview(); setReview(null); setReviewNote(""); setReviewBusy(false); setActionError(null);
    return invalidateReview;
  }, [scope, invalidateReview]);
  const files = graph?.lanes.flatMap((lane) => lane.nodes.filter((n) => n.kind === "file")) ?? [];
  const fileMap = new Map(files.map((file) => [file.filePath!, file]));
  const openNode = (node: TaskNode, session: SessionInfo) => {
    setActionError(null);
    if (node.filePath) onOpenFile?.(node.filePath);
    else void onNavigate?.(session, node.entryId, node.active === false).catch((error: unknown) => setActionError(error instanceof Error ? error.message : String(error)));
  };
  const beginReview = async (node: TaskNode, lane: TaskLane) => {
    if (!node.childSessionId || !node.reportEntryId) return;
    const token = ++reviewGeneration.current;
    setActionError(null);
    try {
      const query = new URLSearchParams({ parentSessionId: lane.session.id, childSessionId: node.childSessionId, reportEntryId: node.reportEntryId });
      const response = await fetch(`/api/workbench/reviews?${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(t(`workbench.${body.error ?? "reviewError"}`));
      const current = body.evidence as ReportEvidence;
      if (!current.fingerprint || !current.resultEntryId) throw new Error(t("workbench.reportUnavailable"));
      if (reviewGeneration.current !== token) return;
      setReview({ parentSessionId: lane.session.id, childSessionId: node.childSessionId, evidence: current, revision: body.revision });
      setReviewNote(current.adoption?.note ?? "");
    } catch (cause) { if (reviewGeneration.current === token) setActionError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const saveReview = async (status: ReportAdoptionStatus) => {
    if (!review || status === "pending") return;
    const token = ++reviewGeneration.current;
    setReviewBusy(true); setActionError(null);
    try {
      const response = await fetch("/api/workbench/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: review.revision, parentSessionId: review.parentSessionId, childSessionId: review.childSessionId, reportEntryId: review.evidence.reportEntryId, resultEntryId: review.evidence.resultEntryId, fingerprint: review.evidence.fingerprint, status, note: reviewNote }) });
      const body = await response.json();
      if (reviewGeneration.current !== token) return;
      if (!response.ok) {
        if (response.status === 409) setReview(null);
        throw new Error(t(`workbench.${body.error ?? "storage"}`));
      }
      setReview({ ...review, evidence: body.evidence, revision: body.revision });
      onRefresh();
    } catch (cause) { if (reviewGeneration.current === token) setActionError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (reviewGeneration.current === token) setReviewBusy(false); }
  };
  const focusEdge = (sessionId: string, entryId: string) => {
    const lane = graph?.lanes.find((item) => item.session.id === sessionId);
    const node = lane?.nodes.find((item) => item.entryId === entryId);
    if (lane && node) openNode(node, lane.session);
  };
  return <aside id="lancer-task-tree" className={`lancer-tree lancer-tree-scope-${scope}`} aria-label={t("workbench.title")}>
    <header><strong>{t("workbench.tree")}</strong><span><button type="button" onClick={onRefresh} aria-label={t("workbench.refresh")}>↻</button><button type="button" onClick={onClose} aria-label={t("workbench.close")}>×</button></span></header>
    <div className="lancer-tree-controls"><select aria-label={t("workbench.tree")} value={scope} onChange={(event) => onScope(event.target.value as TaskScope)}>{(["current", "family", "project"] as const).map((value) => <option value={value} key={value}>{t(`workbench.${value}`)}</option>)}</select>{onFullMap && <button type="button" onClick={onFullMap}>{t("workbench.fullMap")}</button>}</div>
    {actionError && <p role="alert">{actionError}</p>}
    {error && <p role="alert">{t(`workbench.${error}`)} <button onClick={onRefresh}>{t("workbench.retry")}</button></p>}
    {graph?.reviewsError && <p role="alert">{t("workbench.reviewsCorrupt")}</p>}
    {loading && !graph && <p role="status">{t("chat.loadingSession")}</p>}
    <div className="lancer-tree-summary" data-task-counts><span>{t("workbench.tree.counts", counts)}</span>{!following && <button type="button" data-task-jump-latest onClick={() => { const scroll = scrollRef.current; if (scroll) { scroll.dataset.taskFollow = "true"; scroll.scrollTop = scroll.scrollHeight; } setFollowing(true); }}>{t("workbench.tree.latest")}</button>}</div>
    <div className="lancer-tree-scroll" ref={scrollRef} data-task-follow={following} onScroll={(event) => {
      const scroll = event.currentTarget;
      const nearEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 64;
      scroll.dataset.taskFollow = String(nearEnd); setFollowing(nearEnd);
    }}>
      {graph?.edges?.length ? <section className="lancer-lineage" aria-label={t("workbench.lineage")}><h3>{t("workbench.lineage")}</h3>{graph.edges.map((edge) => {
        const sourceSession = graph.lanes.find((lane) => lane.session.id === edge.parentSessionId)?.session;
        const targetSession = graph.lanes.find((lane) => lane.session.id === edge.childSessionId)?.session;
        const report = edge.kind === "return" ? graph.lanes.find((lane) => lane.session.id === edge.parentSessionId)?.nodes.find((node) => node.entryId === edge.targetEntryId) : undefined;
        return <div className="lancer-lineage-edge" key={edge.id} data-edge-kind={edge.kind}>
          <button type="button" onClick={() => focusEdge(edge.kind === "dispatch" ? edge.parentSessionId : edge.childSessionId, edge.sourceEntryId)} title={sourceSession?.name || sourceSession?.firstMessage}>{sourceSession?.name || t("workbench.parent")} · {edge.kind === "dispatch" ? t("workbench.dispatch") : t("workbench.result")}</button>
          <span aria-hidden="true">{edge.kind === "dispatch" ? "→" : "⇠"}</span>
          <button type="button" onClick={() => focusEdge(edge.kind === "dispatch" ? edge.childSessionId : edge.parentSessionId, edge.targetEntryId)} title={targetSession?.name || targetSession?.firstMessage}>{edge.kind === "dispatch" ? targetSession?.name || t("workbench.child") : t(`workbench.review.${report?.adoption?.status ?? "pending"}`)}</button>
        </div>;
      })}</section> : null}
      {review && <section className="lancer-review-panel" aria-label={t("workbench.review.title")}>
        <h3>{t("workbench.review.title")}</h3><p className="lancer-report-body">{review.evidence.text}</p>
        <p>{t(`workbench.review.${review.evidence.adoption?.status ?? "pending"}`)}</p>
        {review.evidence.truncated && <p role="status">{t("workbench.review.truncated")}</p>}
        {review.evidence.staleReview && <p role="status">{t("workbench.review.stale")}</p>}
        {review.evidence.error && <p role="alert">{review.evidence.error}</p>}
        {!review.evidence.canReview && <p role="status">{t("workbench.reportChanged")}</p>}
        {review.evidence.files.map((file) => <div key={file.path || "coverage"}><button disabled={file.state !== "available"} onClick={() => onOpenFile?.(file.path)}>{file.path.split(/[\\/]/).pop() || t("workbench.files")}</button><small>{t(`workbench.fileState.${file.state}`)}</small></div>)}
        <label>{t("workbench.review.note")}<textarea maxLength={1000} value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label>
        <div className="lancer-review-actions">
          <button disabled={reviewBusy || !review.evidence.canReview} onClick={() => { void saveReview("reviewed"); }}>{t("workbench.review.done")}</button>
          <button disabled={reviewBusy || !review.evidence.canReview || review.evidence.truncated || review.evidence.status !== "completed" || review.evidence.files.some((file) => file.state !== "available") || review.evidence.staleReview || !["reviewed", "accepted"].includes(review.evidence.adoption?.status ?? "")} onClick={() => { void saveReview("accepted"); }}>{t("workbench.review.accept")}</button>
          <button disabled={reviewBusy || !review.evidence.canReview || !reviewNote.trim()} onClick={() => { void saveReview("needs_changes"); }}>{t("workbench.review.changes")}</button>
          <button disabled={reviewBusy || !review.evidence.canReview || !reviewNote.trim()} onClick={() => { void saveReview("rejected"); }}>{t("workbench.review.reject")}</button>
          <button disabled={reviewBusy} onClick={() => setReview(null)}>{t("workbench.cancel")}</button>
        </div>
        <p className="lancer-help">{t("workbench.review.gitSeparate")}</p>
      </section>}
      <div className="lancer-lanes" ref={lanesRef}>
        {graph?.edges?.length || graph?.lanes.some((lane) => lane.nodes.some((node) => node.parentId)) ? <TaskLineageOverlay rootRef={lanesRef} lanes={graph.lanes} edges={graph.edges} /> : null}
        {graph?.lanes.map((lane) => <TaskLaneView key={`${scope}:${lane.session.id}`} lane={lane} running={graph.running.includes(lane.session.id)}
          onOpen={(node) => openNode(node, lane.session)} onReview={(node) => { void beginReview(node, lane); }} onRefresh={onRefresh}
          onFork={onFork ? (node) => { void onFork(lane.session, node.entryId).catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause))); } : undefined} />)}</div>
      {graph?.truncated && <p className="lancer-help">{t("workbench.truncated")}</p>}
      {graph && <TurnSnapshotPanel key={graph.sessionId} sessionId={graph.sessionId} running={graph.running.includes(graph.sessionId)} />}
      <section className="lancer-deliverables"><h3>{t("workbench.files")}</h3>{!files.length && <p className="lancer-help">{t("workbench.noFiles")}</p>}{[...fileMap.values()].slice(0, filesExpanded ? fileMap.size : 5).map((file) => <button type="button" key={file.filePath} onClick={() => onOpenFile?.(file.filePath!)} title={file.filePath}>{file.filePath?.replace(/\\/g, "/").split("/").pop()}</button>)}{fileMap.size > 5 && <button type="button" data-task-delivery-toggle aria-expanded={filesExpanded} onClick={() => setFilesExpanded((value) => !value)}>{t(filesExpanded ? "workbench.tree.hideFiles" : "workbench.tree.showFiles", { count: fileMap.size - 5 })}</button>}</section>
    </div>
  </aside>;
}
