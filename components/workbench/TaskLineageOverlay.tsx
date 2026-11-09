"use client";
import { useLayoutEffect, useRef, useState } from "react";
import type { TaskLane, TaskLineageEdge } from "@/lib/workbench/graph";
import { useI18n } from "@/hooks/useI18n";
import { taskLaneColor } from "@/hooks/task-light-anchors";
import { nonLinearTreeLinks } from "@/lib/workbench/tree-links";
interface Line { id: string; d: string; kind: "tree" | "dispatch" | "return"; accepted: boolean; color: string; from?: string; to?: string }
function point(element: HTMLElement, bounds: DOMRect): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top };
}
function anchor(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-task-node="${CSS.escape(id)}"] [data-task-light-target]`)
    ?? root.querySelector<HTMLElement>(`[data-task-node="${CSS.escape(id)}"]`);
}
export function TaskLineageOverlay({ rootRef, lanes = [], edges = [] }: { rootRef: React.RefObject<HTMLDivElement | null>; lanes?: TaskLane[]; edges?: TaskLineageEdge[] }) {
  const { t } = useI18n();
  const [drawing, setDrawing] = useState<{ width: number; height: number; lines: Line[] }>({ width: 0, height: 0, lines: [] });
  // ResizeObserver may schedule unchanged layouts; keep equal measurements out of state.
  const drawn = useRef("");
  useLayoutEffect(() => {
    let frame = 0, observer: ResizeObserver | null = null;
    // A child layout effect runs before React attaches the parent's host ref, so the
    // root is resolved inside the first measured frame instead of here.
    const measure = () => {
      frame = 0;
      const root = rootRef.current;
      if (!root) return;
      if (!observer && typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(() => schedule()); observer.observe(root); }
      const bounds = root.getBoundingClientRect();
      const treeLines = nonLinearTreeLinks(lanes).flatMap((link): Line[] => {
        const source = anchor(root, link.parentId);
        const target = anchor(root, link.nodeId);
        if (!source || !target) return [];
        const a = point(source, bounds), b = point(target, bounds);
        const bend = Math.max(18, Math.abs(b.y - a.y) * 0.35);
        return [{
          id: `tree:${link.laneSessionId}:${link.parentId}:${link.nodeId}`,
          d: `M ${a.x} ${a.y} C ${a.x} ${a.y + bend}, ${b.x} ${b.y - bend}, ${b.x} ${b.y}`,
          kind: "tree",
          accepted: false,
          color: taskLaneColor(link.laneSessionId),
          from: link.parentId,
          to: link.nodeId,
        }];
      });
      const relationLines = edges.slice(0, 160).flatMap((edge): Line[] => {
        const sourceSessionId = edge.kind === "dispatch" ? edge.parentSessionId : edge.childSessionId;
        const targetSessionId = edge.kind === "dispatch" ? edge.childSessionId : edge.parentSessionId;
        const source = anchor(root, `${sourceSessionId}:${edge.sourceEntryId}`);
        const target = anchor(root, `${targetSessionId}:${edge.targetEntryId}`);
        if (!source || !target) return [];
        const a = point(source, bounds), b = point(target, bounds), middle = (a.x + b.x) / 2;
        return [{ id: edge.id, d: `M ${a.x} ${a.y} C ${middle} ${a.y}, ${middle} ${b.y}, ${b.x} ${b.y}`, kind: edge.kind, accepted: edge.adoption?.status === "accepted", color: taskLaneColor(sourceSessionId) }];
      });
      const next = { width: root.scrollWidth, height: root.scrollHeight, lines: [...treeLines, ...relationLines] };
      const key = JSON.stringify(next);
      if (key === drawn.current) return;
      drawn.current = key;
      setDrawing(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    window.addEventListener("resize", schedule);
    schedule();
    return () => { observer?.disconnect(); window.removeEventListener("resize", schedule); cancelAnimationFrame(frame); };
  }, [rootRef, lanes, edges]);
  return <svg className="lancer-lineage-overlay" width={drawing.width} height={drawing.height} viewBox={`0 0 ${drawing.width || 1} ${drawing.height || 1}`} preserveAspectRatio="none" aria-hidden="true" data-task-connections>
    {drawing.lines.map((line) => <path key={line.id} d={line.d} data-task-edge={line.kind === "tree" ? undefined : line.id} data-task-tree-edge={line.kind === "tree" ? line.id : undefined} data-task-edge-from={line.from} data-task-edge-to={line.to} data-task-edge-kind={line.kind} fill="none" stroke={line.color} strokeWidth={line.accepted ? 2 : line.kind === "tree" ? 1 : 1.2} strokeDasharray={line.kind === "return" ? "4 3" : undefined} opacity={line.accepted ? 0.9 : line.kind === "tree" ? 0.42 : 0.5}><title>{t(line.kind === "dispatch" ? "workbench.dispatch" : line.kind === "return" ? "workbench.report" : "workbench.tree")}</title></path>)}
  </svg>;
}
