import type { ToolCallContent } from "../types";

export interface TaskToolOperation {
  /** A call's native message entry and toolCallId; results reuse this exact key. */
  key: string;
  name: string;
  action: "read" | "edit" | "write" | "run" | "search" | "list" | "call";
  target: string;
  edits?: number;
}
const text = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 240) : "";

/** Summaries come from recorded arguments, never a read's contents or shell stdout. */
export function taskToolOperation(call: ToolCallContent, callNodeId: string): TaskToolOperation {
  const input = call.input;
  const actions: Record<string, TaskToolOperation["action"]> = { read: "read", edit: "edit", write: "write", apply_patch: "edit", bash: "run", powershell: "run", grep: "search", find: "search", ls: "list" };
  const action = actions[call.toolName] ?? "call";
  const target = text(input.path ?? input.file_path ?? input.filePath)
    || text(input.command ?? input.cmd)
    || text(input.pattern ?? input.query ?? input.description);
  return { key: `${callNodeId}:tool:${encodeURIComponent(call.toolCallId)}`, name: call.toolName, action, target,
    ...(action === "edit" && Array.isArray(input.edits) && input.edits.length ? { edits: input.edits.length } : {}) };
}

export function compactToolTarget(operation: TaskToolOperation): string {
  if (["read", "edit", "write", "list"].includes(operation.action)) {
    return operation.target.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || operation.target;
  }
  return operation.target;
}
