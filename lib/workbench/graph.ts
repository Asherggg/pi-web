import type { AgentMessage, AssistantMessage, SessionEntry, SessionInfo, ToolResultMessage } from "../types";
import { normalizeToolCalls } from "../normalize";
import { extractTurnWrittenFiles } from "../turn-written-files";
export type TaskScope = "current" | "family" | "project";
export interface TaskNode {
  id: string; sessionId: string; entryId: string; parentId: string | null;
  kind: "user" | "answer" | "tools" | "model" | "summary" | "file" | "report";
  active?: boolean;
  text: string; timestamp: string; error?: boolean; filePath?: string;
}
export interface TaskLane { session: SessionInfo; nodes: TaskNode[]; error?: string; truncated: boolean; model?: string }
export interface TaskGraph { sessionId: string; lanes: TaskLane[]; running: string[]; truncated: boolean }
export function familySessionIds(sessions: SessionInfo[], activeId: string): Set<string> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let root = activeId;
  const seen = new Set<string>();
  while (!seen.has(root)) {
    seen.add(root);
    const relation = byId.get(root)?.relation;
    if (relation?.kind !== "subagent") break;
    root = relation.parentSessionId;
  }
  const family = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const s of sessions) if (s.relation?.kind === "subagent" && family.has(s.relation.parentSessionId) && !family.has(s.id)) { family.add(s.id); changed = true; }
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
  const calls = new Map<string, { message: AssistantMessage; entryId: string }>();
  let model: string | undefined;
  for (const entry of entries) {
    const parentId = entry.parentId ? visible.get(entry.parentId) ?? null : null;
    let node: TaskNode | undefined;
    const base = { id: `${session.id}:${entry.id}`, sessionId: session.id, entryId: entry.id, parentId, timestamp: entry.timestamp };
    if (entry.type === "model_change") {
      model = `${entry.provider}/${entry.modelId}`;
      node = { ...base, kind: "model", text: model };
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      node = { ...base, kind: "summary", text: typeof entry.summary === "string" ? entry.summary.slice(0, 180) : "" };
    } else if (entry.type === "custom_message" && entry.customType === "pi-web:subagent-notification" && entry.display !== false) {
      node = { ...base, kind: "report", text: contentText(entry) };
    } else if (entry.type === "message") {
      const message = normalizeToolCalls(entry.message as AgentMessage);
      if (message.role === "user") node = { ...base, kind: "user", text: contentText(message) };
      else if (message.role === "assistant") {
        const assistant = message as AssistantMessage;
        const tools = Array.isArray(assistant.content) ? assistant.content.filter((b) => b.type === "toolCall") : [];
        for (const tool of tools) calls.set(tool.toolCallId, { message: assistant, entryId: entry.id });
        const text = contentText(assistant);
        if (text || tools.length || assistant.errorMessage) node = { ...base, kind: tools.length ? "tools" : "answer", text: text || tools.map((t) => t.toolName).join(" · ") || assistant.errorMessage || "", error: assistant.stopReason === "error" || assistant.stopReason === "aborted" };
      } else if (message.role === "toolResult") {
        const result = message as ToolResultMessage;
        const call = calls.get(result.toolCallId);
        node = { ...base, kind: "tools", text: `${result.toolName}: ${contentText(result)}`, error: result.isError };
        nodes.push(node);
        visible.set(entry.id, node.id);
        if (call && !result.isError) {
          const results = new Map([[result.toolCallId, result]]);
          for (const file of extractTurnWrittenFiles(call.message.content, results, session.cwd)) nodes.push({ ...base, id: `${base.id}:file:${nodes.length}`, parentId: node.id, kind: "file", text: file.filePath, filePath: file.filePath });
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
