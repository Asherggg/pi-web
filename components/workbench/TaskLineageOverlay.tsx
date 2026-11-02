"use client";
import { useLayoutEffect, useState } from "react";
import type { TaskLineageEdge } from "@/lib/workbench/graph";
import { useI18n } from "@/hooks/useI18n";
interface Line { id: string; d: string; kind: string; accepted: boolean }
export function TaskLineageOverlay({ rootRef, edges }: { rootRef: React.RefObject<HTMLDivElement | null>; edges: TaskLineageEdge[] }) {
  const { t } = useI18n();
  const [drawing, setDrawing] = useState<{ width: number; height: number; lines: Line[] }>({ width: 0, height: 0, lines: [] });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const bounds = root.getBoundingClientRect();
      const lines = edges.slice(0, 160).flatMap((edge): Line[] => {
        const sourceSessionId = edge.kind === "dispatch" ? edge.parentSessionId : edge.childSessionId;
        const targetSessionId = edge.kind === "dispatch" ? edge.childSessionId : edge.parentSessionId;
        const source = root.querySelector<HTMLElement>(`[data-task-node="${CSS.escape(`${sourceSessionId}:${edge.sourceEntryId}`)}"]`);
        const target = root.querySelector<HTMLElement>(`[data-task-node="${CSS.escape(`${targetSessionId}:${edge.targetEntryId}`)}"]`);
        if (!source || !target) return [];
        const a = source.getBoundingClientRect(), b = target.getBoundingClientRect();
        const rightward = a.x < b.x;
        const x1 = (rightward ? a.right : a.left) - bounds.left;
        const x2 = (rightward ? b.left : b.right) - bounds.left;
        const y1 = a.top + a.height / 2 - bounds.top, y2 = b.top + b.height / 2 - bounds.top;
        const middle = (x1 + x2) / 2;
        return [{ id: edge.id, d: `M ${x1} ${y1} C ${middle} ${y1}, ${middle} ${y2}, ${x2} ${y2}`, kind: edge.kind, accepted: edge.adoption?.status === "accepted" }];
      });
      setDrawing({ width: root.scrollWidth, height: root.scrollHeight, lines });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    window.addEventListener("resize", schedule);
    schedule();
    return () => { observer?.disconnect(); window.removeEventListener("resize", schedule); cancelAnimationFrame(frame); };
  }, [rootRef, edges]);
  return <svg className="lancer-lineage-overlay" width={drawing.width} height={drawing.height} aria-hidden="true" data-task-connections>
    {drawing.lines.map((line) => <path key={line.id} d={line.d} data-task-edge={line.id} fill="none" stroke="var(--accent)" strokeWidth={line.accepted ? 2 : 1.2} strokeDasharray={line.kind === "return" ? "4 3" : undefined} opacity={line.accepted ? 0.9 : 0.5}><title>{t(line.kind === "dispatch" ? "workbench.dispatch" : "workbench.report")}</title></path>)}
  </svg>;
}
