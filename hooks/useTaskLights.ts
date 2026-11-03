"use client";
import { useEffect, useRef } from "react";
import { createLightLayer } from "@/lib/vendor/lancer-light-ui/light-layer";
import { createTaskLightController } from "./task-light-controller";
import type { TaskGraph } from "@/lib/workbench/graph";

/** Only a fresh graph generation may establish a baseline; per-source mounts can arrive later. */
export function useTaskLights(rootRef: React.RefObject<HTMLElement | null>, graph: TaskGraph | null, enabled: boolean, sessionId: string, scope: string) {
  const controller = useRef<ReturnType<typeof createTaskLightController> | null>(null);
  useEffect(() => {
    if (!rootRef.current) return;
    const root = rootRef.current;
    const layer = enabled ? createLightLayer(root) : null;
    const next = layer ? createTaskLightController(root, layer, sessionId) : null;
    controller.current = next;
    const visibility = () => {
      root.classList.toggle("light-motion-paused", document.hidden);
      if (document.hidden) next?.hidden();
    };
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility); root.classList.remove("light-motion-paused");
      next?.destroy(); layer?.destroy(); controller.current = null;
    };
  }, [enabled, sessionId, scope, rootRef]);
  useEffect(() => { if (graph && enabled) controller.current?.update(graph); }, [graph, enabled]);
}
