import type { TaskLane } from "@/lib/workbench/graph";
/** The parent links a lane cannot express with its vertical rail: a branch or join. */
export interface TreeLink { laneSessionId: string; parentId: string; nodeId: string }
export const MAX_TREE_LINKS = 240;
export function nonLinearTreeLinks(lanes: TaskLane[]): TreeLink[] {
  const links: TreeLink[] = [];
  for (const lane of lanes) {
    const byId = new Set(lane.nodes.map((node) => node.id));
    for (const [index, node] of lane.nodes.entries()) {
      // The previous entry already sits at the same rail position, and a parent
      // outside this lane is drawn by the dispatch/return edges instead.
      if (!node.parentId || node.parentId === lane.nodes[index - 1]?.id || !byId.has(node.parentId)) continue;
      links.push({ laneSessionId: lane.session.id, parentId: node.parentId, nodeId: node.id });
      if (links.length >= MAX_TREE_LINKS) return links;
    }
  }
  return links;
}
