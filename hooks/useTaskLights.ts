"use client";
import { useEffect, useRef } from "react";
import { createLightLayer, type LightLayer } from "@/lib/vendor/lancer-light-ui/light-layer";
import type { TaskGraph } from "@/lib/workbench/graph";
/** Baseline snapshots are silent; only newly recorded events animate. */
export function useTaskLights(rootRef: React.RefObject<HTMLElement | null>, graph: TaskGraph | null, enabled: boolean, sessionId: string, scope: string) {
  const light = useRef<LightLayer | null>(null);
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    seen.current = null;
    if (!enabled || !rootRef.current) return;
    const layer = createLightLayer(rootRef.current);
    light.current = layer;
    const root = rootRef.current;
    const visibility = () => root.classList.toggle("light-motion-paused", document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { document.removeEventListener("visibilitychange", visibility); root.classList.remove("light-motion-paused"); layer.destroy(); light.current = null; seen.current = null; };
  }, [enabled, sessionId, scope, rootRef]);
  useEffect(() => {
    if (!graph || !enabled) return;
    const nodes = graph.lanes.flatMap((lane) => lane.nodes);
    if (!seen.current) { seen.current = new Set(nodes.map((node) => node.id)); return; }
    for (const node of nodes) {
      if (seen.current.has(node.id)) continue;
      seen.current.add(node.id);
      if (document.hidden || !light.current || light.current.activeCount >= 8 || !["answer", "tools", "file", "report", "model"].includes(node.kind)) continue;
      const root = rootRef.current;
      if (!root) continue;
      const target = root.querySelector<HTMLElement>(`[data-task-node="${CSS.escape(node.id)}"]`);
      const source = root.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(node.entryId)}"]`) ?? root.querySelector<HTMLElement>("[data-workbench-source]");
      if (!target || !source) continue;
      const rect = target.getBoundingClientRect();
      const clip = target.closest(".lancer-tree-scroll")?.getBoundingClientRect();
      if (clip && (rect.top < clip.top || rect.bottom > clip.bottom)) continue;
      const color = getComputedStyle(root).getPropertyValue("--accent").trim() || "#3b82f6";
      light.current.emit({ id: node.id, source, target, color, duration: 700, sourceKind: "model" });
    }
    if (seen.current.size > 5000) seen.current = new Set(nodes.map((node) => node.id));
  }, [graph, enabled, rootRef]);
}
