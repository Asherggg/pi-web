import type { TaskLane, TaskNode } from "./graph";
import type { TaskToolOperation } from "./task-tool-summary";

export const RECENT_TASK_TURNS = 10;
export interface TaskTreeRow {
  id: string;
  node: TaskNode;
  members: TaskNode[];
  operation?: TaskToolOperation;
  settled?: boolean;
}
export interface TaskTurn {
  id: string;
  anchor: TaskNode;
  nodes: TaskNode[];
  rows: TaskTreeRow[];
  highlights: TaskTreeRow[];
  process: TaskTreeRow[];
  toolCount: number;
  fileCount: number;
  error: boolean;
}

/** A display projection only. Native entries, branch parents and report IDs stay intact. */
export function taskTurns(lane: TaskLane): TaskTurn[] {
  const turns = new Map<string, TaskTurn>();
  const byId = new Map(lane.nodes.map((node) => [node.id, node]));
  const assigned = new Map<string, string>();
  function owner(node: TaskNode): string {
    if (node.turnId) return node.turnId;
    const path: TaskNode[] = [], seen = new Set<string>();
    let cursor: TaskNode | undefined = node, result = `${lane.session.id}:context`;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id); path.push(cursor);
      if (cursor.turnId || assigned.has(cursor.id) || cursor.kind === "user") {
        result = cursor.turnId ?? assigned.get(cursor.id) ?? cursor.id; break;
      }
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    for (const item of path) assigned.set(item.id, result);
    return result;
  }
  for (const node of lane.nodes) {
    const id = owner(node);
    let turn = turns.get(id);
    if (!turn) {
      turn = { id: `turn:${id}`, anchor: node, nodes: [], rows: [], highlights: [], process: [], toolCount: 0, fileCount: 0, error: false };
      turns.set(id, turn);
    }
    if (node.id === id) turn.anchor = node;
    turn.nodes.push(node);
  }
  for (const turn of turns.values()) {
    const operations = new Map<string, TaskTreeRow>();
    const ordinary: TaskTreeRow[] = [];
    for (const node of turn.nodes) {
      for (const operation of node.operations ?? []) {
        const existing = operations.get(operation.key);
        if (existing?.settled && node.toolPhase === "result" && existing.node.id !== node.id) {
          // Alternative results under the same historical call are distinct
          // branch entries. Keep both navigable instead of overwriting one.
          const id = `${operation.key}:result:${node.id}`;
          operations.set(id, { id, node, members: [...existing.members.filter((member) => member.toolPhase === "call"), node], operation, settled: true });
        } else if (existing) {
          if (!existing.members.includes(node)) existing.members.push(node);
          if (node.toolPhase === "result") { existing.node = node; existing.settled = true; }
        } else operations.set(operation.key, { id: operation.key, node, members: [node], operation, settled: node.toolPhase === "result" });
      }
      if (node.kind !== "tools" || !node.operations?.length) ordinary.push({ id: node.id, node, members: [node] });
    }
    // A native subagent report is already a single actionable result row.
    const tools = [...operations.values()].filter((row) => row.node.kind !== "report");
    const order = new Map(turn.nodes.map((node, index) => [node.id, index]));
    turn.rows = [...ordinary, ...tools].sort((a, b) => (order.get(a.members[0].id) ?? 0) - (order.get(b.members[0].id) ?? 0));
    const lastAnswer = ordinary.filter((row) => row.node.kind === "answer").at(-1);
    const fileRows = new Map<string, TaskTreeRow>();
    for (const row of ordinary.filter((row) => row.node.filePath)) {
      const path = row.node.filePath!;
      const previous = fileRows.get(path);
      fileRows.set(path, { ...row, id: `file:${turn.id}:${encodeURIComponent(path)}`, members: [...(previous?.members ?? []), row.node] });
    }
    turn.highlights = [...turn.rows.filter((row) => !row.node.filePath && (row === lastAnswer || row.node.error
      || ["report", "result", "model"].includes(row.node.kind))), ...fileRows.values()];
    const highlightIds = new Set(turn.highlights.flatMap((row) => [row.id, ...row.members.map((node) => node.id)]));
    const anchorHasRow = turn.highlights.some((row) => row.node.id === turn.anchor.id);
    turn.process = turn.rows.filter((row) => !highlightIds.has(row.id) && (row.node.id !== turn.anchor.id || anchorHasRow));
    turn.toolCount = operations.size + turn.rows.filter((row) => row.node.kind === "tools" && !row.operation).length;
    turn.fileCount = new Set(turn.nodes.filter((node) => node.filePath).map((node) => node.filePath)).size;
    turn.error = turn.nodes.some((node) => node.error);
  }
  return [...turns.values()];
}

export function currentTaskTurn(turns: TaskTurn[]): string | null {
  return turns.findLast((turn) => turn.nodes.some((node) => node.active === true))?.id ?? turns.at(-1)?.id ?? null;
}

/** Explicit native-node -> rendered-anchor mapping, including folds and merged calls. */
export function turnAnchorOwners(turn: TaskTurn, open: boolean, rows: TaskTreeRow[]): Map<string, string> {
  const owners = new Map(turn.nodes.map((node) => [node.id, turn.id]));
  if (!open) return owners;
  owners.set(turn.anchor.id, turn.id);
  // A multi-tool assistant entry maps to the turn until a specific result supplies
  // a unique node. Never pick an arbitrary first tool from a batched call.
  const targets = new Map<string, Set<string>>();
  for (const row of rows) for (const node of row.members) {
    if (node.id === turn.anchor.id && node.kind === "user") continue;
    const ids = targets.get(node.id) ?? new Set<string>(); ids.add(row.id); targets.set(node.id, ids);
  }
  for (const [id, targetsForNode] of targets) if (targetsForNode.size === 1) owners.set(id, [...targetsForNode][0]);
  return owners;
}
