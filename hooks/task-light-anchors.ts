import type { TaskGraph } from "@/lib/workbench/graph";

// Lancer's authored git-tree palette; a session keeps its color across scope changes.
const LANE_COLORS = ["#3B82F6", "#8B5CF6", "#10B981", "#DB2777", "#F59E0B"] as const;
export function taskLaneColor(id: string): string {
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return LANE_COLORS[hash % LANE_COLORS.length];
}

/** Follow only the work tree, never the chat or the document. */
export function revealTaskTarget(target: HTMLElement): void {
  const scroll = target.closest<HTMLElement>(".lancer-tree-scroll");
  if (!scroll) return;
  const node = target.closest<HTMLElement>(".lancer-tree-node") ?? target;
  const rect = node.getBoundingClientRect();
  const clip = scroll.getBoundingClientRect();
  if (rect.bottom > clip.bottom) scroll.scrollTop += rect.bottom - clip.bottom + 10;
  else if (rect.top < clip.top) scroll.scrollTop -= clip.top - rect.top + 10;
  if (rect.right > clip.right) scroll.scrollLeft += rect.right - clip.right + 10;
  else if (rect.left < clip.left) scroll.scrollLeft -= clip.left - rect.left + 10;
}

/** A hidden/virtualized source is absent, not permission to use a nearby bubble. */
export function visibleTaskAnchor(root: HTMLElement, selector: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const style = getComputedStyle(element);
    if (!element.getClientRects().length || style.visibility === "hidden" || style.opacity === "0") continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const surface = root.getBoundingClientRect();
    const pane = element.closest<HTMLElement>("[data-workbench-chat-scroll], .lancer-tree-scroll");
    const clip = pane?.getBoundingClientRect() ?? surface;
    if (rect.top < clip.top || rect.bottom > clip.bottom || rect.left < clip.left || rect.right > clip.right) continue;
    let left = Math.max(surface.left, clip.left), right = Math.min(surface.right, clip.right);
    let top = Math.max(surface.top, clip.top), bottom = Math.min(surface.bottom, clip.bottom);
    const viewport = root.ownerDocument?.defaultView?.visualViewport;
    if (viewport) {
      left = Math.max(left, viewport.offsetLeft); right = Math.min(right, viewport.offsetLeft + viewport.width);
      top = Math.max(top, viewport.offsetTop); bottom = Math.min(bottom, viewport.offsetTop + viewport.height);
    }
    let hidden = false;
    for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
      const css = getComputedStyle(parent);
      if (css.visibility === "hidden" || css.opacity === "0") { hidden = true; break; }
      const bounds = parent.getBoundingClientRect();
      if (/^(hidden|clip|auto|scroll)$/.test(css.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      if (/^(hidden|clip|auto|scroll)$/.test(css.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
    }
    if (hidden || rect.top < top || rect.bottom > bottom || rect.left < left || rect.right > right) continue;
    return element;
  }
  return null;
}

export function collectNewLightNodes(graph: TaskGraph, seen: Set<string>): TaskGraph["lanes"][number]["nodes"] {
  const nodes = graph.lanes.flatMap((lane) => lane.nodes);
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    // Low-level tool rows and user prompts do not fire a second stream of light.
    return ["answer", "file", "report", "result", "model"].includes(node.kind);
  });
}
