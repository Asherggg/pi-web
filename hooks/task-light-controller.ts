import type { LightLayer } from "@/lib/vendor/lancer-light-ui/light-layer";
import type { TaskGraph, TaskNode } from "@/lib/workbench/graph";
import { collectNewLightNodes, revealTaskTarget, taskLaneColor, visibleTaskAnchor } from "./task-light-anchors";

const MAX_FLIGHTS = 32;
const MAX_PENDING_EVENTS = 64;
const PENDING_SOURCE_MS = 15000;
interface Pending { node: TaskNode; since: number; revealed: boolean; model: boolean; message: boolean }

/** Wait for canonical DOM IDs, not the nearest bubble. Each source is consumed separately. */
export function createTaskLightController(root: HTMLElement, layer: LightLayer, sessionId: string) {
  const win = root.ownerDocument.defaultView!;
  const pending = new Map<string, Pending>();
  let seen = new Set<string>(), baseline = false, destroyed = false, frame = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (!destroyed && pending.size && !root.ownerDocument.hidden && !frame) frame = win.requestAnimationFrame(flush);
  };
  const armExpiry = () => {
    clearTimeout(expiry); expiry = undefined;
    if (pending.size) {
      const earliest = Math.min(...Array.from(pending.values(), (job) => job.since + PENDING_SOURCE_MS));
      expiry = setTimeout(schedule, Math.max(1, earliest - performance.now()));
    }
  };
  function flush() {
    frame = 0;
    if (destroyed || root.ownerDocument.hidden) return;
    for (const [id, job] of pending) {
      if (performance.now() - job.since >= PENDING_SOURCE_MS) { pending.delete(id); continue; }
      const targetSelector = `[data-task-light-target="${CSS.escape(job.node.id)}"]`;
      const target = root.querySelector<HTMLElement>(targetSelector);
      if (!target) continue;
      if (!job.revealed) { revealTaskTarget(target); job.revealed = true; }
      if (!visibleTaskAnchor(root, targetSelector)) continue;
      const modelSelector = job.node.sessionId === sessionId
        ? ".lancer-conversation [data-workbench-model-source]"
        : `[data-workbench-lane-model="${CSS.escape(job.node.sessionId)}"]`;
      const sources = [
        { kind: "model" as const, selector: modelSelector },
        { kind: "message" as const, selector: `.lancer-conversation [data-entry-id="${CSS.escape(job.node.entryId)}"]` },
      ];
      for (const { kind, selector } of sources) {
        if (job[kind] || layer.activeCount >= MAX_FLIGHTS || !visibleTaskAnchor(root, selector)) continue;
        job[kind] = true;
        const flight = layer.emit({
          id: `${id}:${kind}`,
          source: () => visibleTaskAnchor(root, selector),
          target: () => visibleTaskAnchor(root, targetSelector),
          color: taskLaneColor(job.node.sessionId),
          sourceKind: kind,
          // Native default: 1200ms. Anchor callbacks also cancel flights clipped later.
        });
        void flight.finished.then(schedule, schedule);
      }
      if (job.model && job.message) pending.delete(id);
    }
    armExpiry();
  }
  const observer = new MutationObserver(schedule);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-entry-id", "class", "style", "hidden"] });
  root.addEventListener("scroll", schedule, { capture: true, passive: true });
  win.addEventListener("resize", schedule);
  return {
    update(graph: TaskGraph) {
      if (destroyed) return;
      if (!baseline || root.ownerDocument.hidden) {
        seen = new Set(graph.lanes.flatMap((lane) => lane.nodes.map((node) => node.id)));
        baseline = !root.ownerDocument.hidden;
        pending.clear(); armExpiry(); return;
      }
      for (const node of collectNewLightNodes(graph, seen)) {
        if (pending.size >= MAX_PENDING_EVENTS) pending.delete(pending.keys().next().value!);
        pending.set(node.id, { node, since: performance.now(), revealed: false, model: false, message: node.sessionId !== sessionId });
      }
      if (seen.size > 5000) seen = new Set(graph.lanes.flatMap((lane) => lane.nodes.map((node) => node.id)));
      schedule(); armExpiry();
    },
    hidden() { baseline = false; pending.clear(); armExpiry(); },
    destroy() {
      destroyed = true; observer.disconnect(); pending.clear(); clearTimeout(expiry); win.cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule, true); win.removeEventListener("resize", schedule);
    },
  };
}
