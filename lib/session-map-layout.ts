import type { SessionMapEdge, SessionMapNode } from "./session-map";

export const SESSION_MAP_CARD_WIDTH = 310;
export const SESSION_MAP_CARD_HEIGHT = 276;
export const SESSION_MAP_CARD_GAP_X = 55;
export const SESSION_MAP_CARD_GAP_Y = 42;

export interface SessionMapPosition {
  x: number;
  y: number;
}

export function layoutSessionMap(
  nodes: SessionMapNode[],
  edges: SessionMapEdge[],
): Map<string, SessionMapPosition> {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const children = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const siblings = children.get(edge.source) ?? [];
    if (!siblings.includes(edge.target)) siblings.push(edge.target);
    children.set(edge.source, siblings);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const sortIds = (ids: string[]) => ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  for (const siblings of children.values()) sortIds(siblings);

  const roots = sortIds(nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id));
  const positions = new Map<string, SessionMapPosition>();
  let nextLane = 0;

  const place = (rootId: string, initialLane: number) => {
    const stack = [{ id: rootId, depth: 0, lane: initialLane }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (positions.has(current.id)) continue;
      positions.set(current.id, {
        x: 86 + current.depth * (SESSION_MAP_CARD_WIDTH + SESSION_MAP_CARD_GAP_X),
        y: 82 + current.lane * (SESSION_MAP_CARD_HEIGHT + SESSION_MAP_CARD_GAP_Y),
      });
      const descendants = children.get(current.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index -= 1) {
        const lane = index === 0 ? current.lane : nextLane++;
        stack.push({ id: descendants[index], depth: current.depth + 1, lane });
      }
    }
  };

  for (const root of roots) {
    const lane = nextLane++;
    place(root, lane);
  }
  for (const node of nodes) {
    if (positions.has(node.id)) continue;
    place(node.id, nextLane++);
  }

  return positions;
}

export function sessionMapConnectorPath(
  from: SessionMapPosition,
  to: SessionMapPosition,
): string {
  const fromX = from.x + SESSION_MAP_CARD_WIDTH;
  const fromY = from.y + SESSION_MAP_CARD_HEIGHT / 2;
  const toX = to.x;
  const toY = to.y + SESSION_MAP_CARD_HEIGHT / 2;
  const bend = Math.min(110, Math.max(36, Math.abs(toX - fromX) * 0.2));
  return `M ${fromX} ${fromY} C ${fromX + bend} ${fromY}, ${toX - bend} ${toY}, ${toX} ${toY}`;
}
