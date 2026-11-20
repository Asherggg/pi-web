import type { AgentMessage, AssistantMessage, SessionEntry, SessionInfo, ToolResultMessage } from "../types";
import type { ReportAdoption } from "./workflow";
import { normalizeToolCalls } from "../normalize";
import { isHiddenRelation } from "../session-family";
import { extractTurnWrittenFiles } from "../turn-written-files";
import { taskToolOperation, type TaskToolOperation } from "./task-tool-summary";
export type TaskScope = "current" | "family" | "project";
export interface TaskNode {
  id: string; sessionId: string; entryId: string; parentId: string | null;
  kind: "user" | "answer" | "tools" | "model" | "summary" | "file" | "report" | "result";
  active?: boolean;
  /** Native user/report ancestor, retained even when the node window cuts its prompt off. */
  turnId?: string;
  operations?: TaskToolOperation[];
  toolPhase?: "call" | "result";
  text: string; timestamp: string; error?: boolean; filePath?: string;
  reportEntryId?: string; resultEntryId?: string; toolCallIds?: string[]; childSessionId?: string; completedAt?: string;
  reviewable?: boolean; reviewError?: string; adoption?: ReportAdoption; staleReview?: boolean;
}
export interface TaskLane { session: SessionInfo; nodes: TaskNode[]; error?: string; truncated: boolean; model?: string }
export interface TaskLineageEdge {
  id: string; kind: "dispatch" | "return"; parentSessionId: string; childSessionId: string;
  sourceEntryId: string; targetEntryId: string; reportEntryId?: string; adoption?: ReportAdoption;
}
export interface TaskGraph { sessionId: string; lanes: TaskLane[]; running: string[]; truncated: boolean; edges: TaskLineageEdge[]; reviewsError?: string }
export function buildTaskLineageEdges(lanes: TaskLane[], childRuns: Array<{ childSessionId: string; parentSessionId: string; parentToolCallId: string }>): TaskLineageEdge[] {
  const edges: TaskLineageEdge[] = [];
  for (const run of childRuns) {
    const parent = lanes.find((lane) => lane.session.id === run.parentSessionId);
    const child = lanes.find((lane) => lane.session.id === run.childSessionId);
    if (!parent || !child) continue;
    const source = parent.nodes.find((node) => node.toolCallIds?.includes(run.parentToolCallId));
    const start = child.nodes.find((node) => node.kind === "user" && node.active !== false);
    if (source && start) edges.push({ id: `dispatch:${run.childSessionId}:${run.parentToolCallId}`, kind: "dispatch", parentSessionId: run.parentSessionId, childSessionId: run.childSessionId, sourceEntryId: source.entryId, targetEntryId: start.entryId });
    for (const report of parent.nodes.filter((node) => node.kind === "report" && node.childSessionId === run.childSessionId && node.completedAt)) {
      const candidates = child.nodes.filter((node) => node.kind === "result" && (report.resultEntryId ? node.entryId === report.resultEntryId : node.completedAt === report.completedAt));
      const result = candidates.length === 1 ? candidates[0] : undefined;
      if (result) edges.push({ id: `return:${parent.session.id}:${report.entryId}`, kind: "return", parentSessionId: run.parentSessionId, childSessionId: run.childSessionId, sourceEntryId: result.entryId, targetEntryId: report.entryId, reportEntryId: report.reportEntryId, adoption: report.staleReview ? undefined : report.adoption });
    }
  }
  return edges;
}
export function familySessionIds(sessions: SessionInfo[], activeId: string): Set<string> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let root = activeId;
  const seen = new Set<string>();
  while (!seen.has(root)) {
    seen.add(root);
    const relation = byId.get(root)?.relation;
    if (!isHiddenRelation(relation)) break;
    root = relation.parentSessionId;
  }
  const family = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of sessions) if (isHiddenRelation(s.relation) && family.has(s.relation.parentSessionId) && !family.has(s.id)) { family.add(s.id); changed = true; }
  }
  return family;
}
function contentText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content.slice(0, 180);
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text.slice(0, 180)).join(" ").slice(0, 180);
}
/** View projection only: native entry identities stay authoritative. */
export function buildTaskLane(session: SessionInfo, entries: SessionEntry[], maxNodes = 300): TaskLane {
  const nodes: TaskNode[] = [];
  const visible = new Map<string, string | null>();
  const calls = new Map<string, Map<string, { message: AssistantMessage; entryId: string; operation: TaskToolOperation }>>();
  const parents = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const findCall = (parentId: string | null, toolCallId: string) => {
    const visited = new Set<string>();
    let cursor = parentId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const call = calls.get(cursor)?.get(toolCallId);
      if (call) return call;
      cursor = parents.get(cursor) ?? null;
    }
    return undefined;
  };
  const turns = new Map<string, string>();
  let model: string | undefined;
  for (const entry of entries) {
    const isTurn = entry.type === "message" && entry.message.role === "user"
      || entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification" && entry.display !== false
      || entry.type === "compaction" || entry.type === "branch_summary";
    const turnId = isTurn ? `${session.id}:${entry.id}` : (entry.parentId ? turns.get(entry.parentId) : undefined) ?? `${session.id}:context`;
    turns.set(entry.id, turnId);
    const parentId = entry.parentId ? visible.get(entry.parentId) ?? null : null;
    let node: TaskNode | undefined;
    const base = { id: `${session.id}:${entry.id}`, sessionId: session.id, entryId: entry.id, parentId, turnId, timestamp: entry.timestamp };
    if (entry.type === "model_change") {
      model = `${entry.provider}/${entry.modelId}`;
      node = { ...base, kind: "model", text: model };
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      node = { ...base, kind: "summary", text: typeof entry.summary === "string" ? entry.summary.slice(0, 180) : "" };
    } else if (entry.type === "custom" && entry.customType === "pi-web:subagent-result" && entry.data && typeof entry.data === "object") {
      const data = entry.data as Record<string, unknown>;
      node = { ...base, kind: "result", text: typeof data.result === "string" ? data.result.slice(0, 180) : typeof data.error === "string" ? data.error.slice(0, 180) : String(data.status ?? ""), completedAt: typeof data.completedAt === "string" ? data.completedAt : undefined, error: data.status !== "completed" };
    } else if (entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification" && entry.display !== false) {
      const details = entry.details && typeof entry.details === "object" && !Array.isArray(entry.details) ? entry.details as Record<string, unknown> : {};
      node = { ...base, kind: "report", text: contentText(entry), reportEntryId: entry.id, childSessionId: details.kind === "pi-web-subagent" && typeof details.sessionId === "string" ? details.sessionId : undefined, completedAt: typeof details.completedAt === "string" ? details.completedAt : undefined, resultEntryId: typeof details.resultEntryId === "string" ? details.resultEntryId : undefined };
    } else if (entry.type === "message") {
      const message = normalizeToolCalls(entry.message as AgentMessage);
      if (message.role === "user") node = { ...base, kind: "user", text: contentText(message) };
      else if (message.role === "assistant") {
        const assistant = message as AssistantMessage;
        const tools = Array.isArray(assistant.content) ? assistant.content.filter((b) => b.type === "toolCall") : [];
        const operations = tools.map((tool) => taskToolOperation(tool, base.id));
        if (tools.length) calls.set(entry.id, new Map(tools.map((tool, index) => [tool.toolCallId, { message: assistant, entryId: entry.id, operation: operations[index] }])));
        const text = contentText(assistant);
        if (text || tools.length || assistant.errorMessage) node = { ...base, kind: tools.length ? "tools" : "answer", text: tools.length ? operations.map((operation) => `${operation.name} ${operation.target}`.trim()).join(" · ").slice(0, 180) : text || assistant.errorMessage || "", error: assistant.stopReason === "error" || assistant.stopReason === "aborted", ...(tools.length ? { toolCallIds: tools.map((tool) => tool.toolCallId), operations, toolPhase: "call" as const } : {}) };
      } else if (message.role === "toolResult") {
        const result = message as ToolResultMessage;
        const call = findCall(entry.parentId, result.toolCallId);
        const details = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details as Record<string, unknown> : {};
        const report = details.kind === "pi-web-subagent" && typeof details.completedAt === "string" && ["completed", "failed", "aborted"].includes(String(details.status));
        const operation = call?.operation ?? taskToolOperation({ type: "toolCall", toolCallId: result.toolCallId, toolName: result.toolName ?? "tool", input: {} }, base.id);
        node = { ...base, kind: report ? "report" : "tools", text: report ? `${result.toolName}: ${contentText(result)}` : `${operation.name} ${operation.target}`.trim(), error: result.isError,
          operations: [operation], toolPhase: "result" as const,
          ...(details.kind === "pi-web-subagent" && typeof details.sessionId === "string" ? { childSessionId: details.sessionId, reportEntryId: entry.id, completedAt: typeof details.completedAt === "string" ? details.completedAt : undefined, resultEntryId: typeof details.resultEntryId === "string" ? details.resultEntryId : undefined } : {}) };
        nodes.push(node);
        visible.set(entry.id, node.id);
        if (call && !result.isError) {
          const results = new Map([[result.toolCallId, result]]);
          for (const file of extractTurnWrittenFiles(call.message.content, results, session.cwd)) nodes.push({ ...base, id: `${base.id}:file:${encodeURIComponent(file.filePath)}`, parentId: node.id, kind: "file", text: file.filePath, filePath: file.filePath });
        }
        continue;
      } else if (message.role === "custom" && message.customType === "pi-web:subagent-notification") {
        node = { ...base, kind: "report", text: contentText(message) };
      }
    }
    if (node) nodes.push(node);
    visible.set(entry.id, node?.id ?? parentId);
  }
  const truncated = nodes.length > maxNodes;
  return { session, nodes: nodes.slice(-maxNodes), truncated, model };
}
