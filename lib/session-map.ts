import type {
  AssistantMessage,
  SessionEntry,
  SessionInfo,
  SessionMessageEntry,
  ToolCallContent,
  UserMessage,
} from "./types";

export const SESSION_MAP_MAX_SESSIONS = 80;
export const SESSION_MAP_MAX_NODES = 300;
export const SESSION_MAP_ACTIVE_TAIL_NODES = 240;
export const SESSION_MAP_MAX_PATHS_PER_SESSION = 120;
export const SESSION_MAP_MAX_ENTRIES_PER_PATH = 6_000;
export const SESSION_MAP_MAX_TEXT = 1_600;

export interface SessionMapSource {
  session: SessionInfo;
  entries: SessionEntry[];
  leafId: string | null;
}

export interface SessionMapNode {
  id: string;
  positionKey: string;
  familyId: string;
  question: string;
  answer: string | null;
  answerState: "complete" | "error" | "none";
  userEntryId: string;
  answerEntryId: string | null;
  navigateEntryId: string;
  sessionIds: string[];
  primarySessionId: string;
  turnIndex: number;
  timestamp: string;
  toolCallCount: number;
}

export interface SessionMapEdge {
  id: string;
  source: string;
  target: string;
  kind: "continue" | "branch";
}

export interface SessionMapData {
  projectKey: string;
  projectRoot: string;
  activeSessionId: string;
  activeNodeId: string | null;
  activeNodeBySession: Record<string, string | null>;
  sessions: SessionInfo[];
  runningSessionIds: string[];
  nodes: SessionMapNode[];
  edges: SessionMapEdge[];
  truncated: boolean;
}

interface MutableNode extends SessionMapNode {
  sessionIds: string[];
  latestSessionModified: string;
}

interface TurnProjection {
  id: string;
  parentId: string | null;
  question: string;
  answer: string | null;
  answerState: "complete" | "error" | "none";
  userEntryId: string;
  answerEntryId: string | null;
  navigateEntryId: string;
  turnIndex: number;
  timestamp: string;
  toolCallCount: number;
}

function boundedText(text: string, maxLength = SESSION_MAP_MAX_TEXT): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return boundedText(content);
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push(candidate.text);
    } else if (candidate.type === "image") {
      imageCount += 1;
    }
  }
  if (imageCount > 0) parts.push(`[${imageCount} image${imageCount === 1 ? "" : "s"}]`);
  return boundedText(parts.join("\n"));
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
  if (entry.type !== "message" || !("message" in entry)) return false;
  const message = (entry as { message?: unknown }).message;
  return typeof message === "object" && message !== null && "role" in message;
}

function isUserEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: UserMessage } {
  return isMessageEntry(entry) && entry.message.role === "user";
}

function isAssistantEntry(entry: SessionEntry): entry is SessionMessageEntry & { message: AssistantMessage } {
  return isMessageEntry(entry) && entry.message.role === "assistant";
}

function assistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) return boundedText(message.errorMessage || "");
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n");
  return boundedText(text || message.errorMessage || "");
}

function assistantToolCount(message: AssistantMessage): number {
  if (!Array.isArray(message.content)) return 0;
  return message.content.filter((block): block is ToolCallContent => (
    typeof block === "object" && block !== null && block.type === "toolCall"
  )).length;
}

function rootFamilyId(sessionId: string, parentBySession: Map<string, string>): string {
  let current = sessionId;
  const seen = new Set<string>();
  while (true) {
    if (seen.has(current)) return sessionId;
    seen.add(current);
    const parent = parentBySession.get(current);
    if (!parent) return current;
    current = parent;
  }
}

function pathsForLeafIds(
  entries: SessionEntry[],
  leafIds: string[],
): { path: SessionEntry[]; leafId: string; truncated: boolean }[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return leafIds.flatMap((leafId) => {
    const reversed: SessionEntry[] = [];
    const seen = new Set<string>();
    let current = byId.get(leafId);
    while (current && !seen.has(current.id) && reversed.length < SESSION_MAP_MAX_ENTRIES_PER_PATH) {
      reversed.push(current);
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (reversed.length === 0) return [];
    return [{ path: reversed.reverse(), leafId, truncated: Boolean(current) }];
  });
}

function nodePositionKey(familyId: string, userEntryId: string): string {
  return `${familyId}:${userEntryId}`;
}

function nodeId(familyId: string, userEntryId: string, answerEntryId: string | null): string {
  return `${nodePositionKey(familyId, userEntryId)}:${answerEntryId ?? "pending"}`;
}

function projectPath(path: SessionEntry[], familyId: string): TurnProjection[] {
  const turns: TurnProjection[] = [];
  let current: {
    user: SessionMessageEntry & { message: UserMessage };
    answerEntryId: string | null;
    answer: string | null;
    answerState: "complete" | "error" | "none";
    navigateEntryId: string;
    toolCallCount: number;
  } | null = null;

  const finish = () => {
    if (!current) return;
    const id = nodeId(familyId, current.user.id, current.answerEntryId);
    turns.push({
      id,
      parentId: turns.at(-1)?.id ?? null,
      question: textFromContent(current.user.message.content) || "[user message]",
      answer: current.answer,
      answerState: current.answerState,
      userEntryId: current.user.id,
      answerEntryId: current.answerEntryId,
      navigateEntryId: current.navigateEntryId,
      turnIndex: turns.length,
      timestamp: current.user.timestamp,
      toolCallCount: current.toolCallCount,
    });
  };

  for (const entry of path) {
    if (isUserEntry(entry)) {
      finish();
      current = {
        user: entry,
        answerEntryId: null,
        answer: null,
        answerState: "none",
        navigateEntryId: entry.id,
        toolCallCount: 0,
      };
      continue;
    }
    if (!current) continue;
    if (isAssistantEntry(entry)) {
      const text = assistantText(entry.message);
      current.answerEntryId = entry.id;
      current.navigateEntryId = entry.id;
      current.answer = text || null;
      current.answerState = entry.message.errorMessage ? "error" : "complete";
      current.toolCallCount += assistantToolCount(entry.message);
    } else if (isMessageEntry(entry) && entry.message.role === "toolResult") {
      current.navigateEntryId = entry.id;
    }
  }
  finish();
  return turns;
}

function activePathLeaf(source: SessionMapSource): string | null {
  if (source.entries.length === 0) return null;
  if (source.leafId && source.entries.some((entry) => entry.id === source.leafId)) return source.leafId;
  return source.entries.at(-1)?.id ?? null;
}

function structuralLeafIds(entries: SessionEntry[]): string[] {
  const byId = new Set(entries.map((entry) => entry.id));
  const parentsWithChildren = new Set<string>();
  for (const entry of entries) {
    if (entry.parentId && byId.has(entry.parentId)) parentsWithChildren.add(entry.parentId);
  }
  return entries.filter((entry) => !parentsWithChildren.has(entry.id)).map((entry) => entry.id);
}

function activeNodeForSource(source: SessionMapSource, familyId: string): string | null {
  const leaf = activePathLeaf(source);
  if (!leaf) return null;
  const byId = new Map(source.entries.map((entry) => [entry.id, entry]));
  let current = byId.get(leaf);
  let answerEntryId: string | null = null;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (isAssistantEntry(current) && answerEntryId === null) answerEntryId = current.id;
    if (isUserEntry(current)) return nodeId(familyId, current.id, answerEntryId);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

export function buildSessionMap(
  sources: SessionMapSource[],
  activeSessionId: string,
  completeParentBySession?: Map<string, string>,
): Omit<SessionMapData, "projectKey" | "projectRoot" | "sessions" | "runningSessionIds"> {
  const parentBySession = new Map(completeParentBySession);
  for (const source of sources) {
    if (source.session.parentSessionId) {
      parentBySession.set(source.session.id, source.session.parentSessionId);
    }
  }

  const nodes = new Map<string, MutableNode>();
  const edgePairs = new Map<string, { source: string; target: string }>();
  let activeNodeId: string | null = null;
  const activeNodeBySession: Record<string, string | null> = {};
  let truncated = false;

  const orderedSources = [...sources].sort((a, b) => {
    if (a.session.id === activeSessionId) return -1;
    if (b.session.id === activeSessionId) return 1;
    return b.session.modified.localeCompare(a.session.modified);
  });

  for (const source of orderedSources.slice(0, SESSION_MAP_MAX_SESSIONS)) {
    const familyId = rootFamilyId(source.session.id, parentBySession);
    const activeNodeCandidate = activeNodeForSource(source, familyId);
    const structuralLeaves = structuralLeafIds(source.entries).reverse();
    const pathLeafIds = [...new Set([
      ...(source.leafId ? [source.leafId] : []),
      ...structuralLeaves,
    ])].slice(0, SESSION_MAP_MAX_PATHS_PER_SESSION);
    if (structuralLeaves.length > SESSION_MAP_MAX_PATHS_PER_SESSION) truncated = true;
    const paths = pathsForLeafIds(source.entries, pathLeafIds);
    if (paths.some((candidate) => candidate.truncated)) truncated = true;

    for (const { path } of paths) {
      const allTurns = projectPath(path, familyId);
      const activePath = source.session.id === activeSessionId
        && activeNodeCandidate !== null
        && allTurns.some((turn) => turn.id === activeNodeCandidate);
      const turns = activePath && allTurns.length > SESSION_MAP_ACTIVE_TAIL_NODES
        ? allTurns.slice(-SESSION_MAP_ACTIVE_TAIL_NODES).map((turn, index, kept) => ({
            ...turn,
            parentId: index === 0 ? null : kept[index - 1].id,
          }))
        : allTurns;
      if (turns.length < allTurns.length) truncated = true;
      for (const turn of turns) {
        if (nodes.size >= SESSION_MAP_MAX_NODES && !nodes.has(turn.id)) {
          truncated = true;
          continue;
        }
        const existing = nodes.get(turn.id);
        if (existing) {
          if (!existing.sessionIds.includes(source.session.id)) existing.sessionIds.push(source.session.id);
          if (source.session.modified > existing.latestSessionModified) {
            existing.primarySessionId = source.session.id;
            existing.latestSessionModified = source.session.modified;
          }
        } else {
          nodes.set(turn.id, {
            id: turn.id,
            positionKey: nodePositionKey(familyId, turn.userEntryId),
            familyId,
            question: turn.question,
            answer: turn.answer,
            answerState: turn.answerState,
            userEntryId: turn.userEntryId,
            answerEntryId: turn.answerEntryId,
            navigateEntryId: turn.navigateEntryId,
            sessionIds: [source.session.id],
            primarySessionId: source.session.id,
            turnIndex: turn.turnIndex,
            timestamp: turn.timestamp,
            toolCallCount: turn.toolCallCount,
            latestSessionModified: source.session.modified,
          });
        }
        if (turn.parentId) {
          edgePairs.set(`${turn.parentId}->${turn.id}`, { source: turn.parentId, target: turn.id });
        }
      }
      if (activeNodeCandidate && nodes.has(activeNodeCandidate)) {
        activeNodeBySession[source.session.id] = activeNodeCandidate;
        if (source.session.id === activeSessionId) activeNodeId = activeNodeCandidate;
      }
    }
    activeNodeBySession[source.session.id] ??= null;
  }

  const positionGroups = new Map<string, MutableNode[]>();
  for (const node of nodes.values()) {
    const key = nodePositionKey(node.familyId, node.userEntryId);
    const group = positionGroups.get(key) ?? [];
    group.push(node);
    positionGroups.set(key, group);
  }
  for (const [key, group] of positionGroups) {
    if (group.length === 1) {
      group[0].positionKey = key;
      continue;
    }
    for (const node of group) node.positionKey = `${key}:${node.answerEntryId ?? "pending"}`;
  }

  if (activeNodeId && !nodes.has(activeNodeId)) activeNodeId = null;

  if (sources.length > SESSION_MAP_MAX_SESSIONS) truncated = true;
  const outgoing = new Map<string, number>();
  for (const edge of edgePairs.values()) {
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }

  const edges: SessionMapEdge[] = [...edgePairs.values()]
    .filter((edge) => nodes.has(edge.source) && nodes.has(edge.target))
    .map((edge) => ({
      id: `${edge.source}->${edge.target}`,
      source: edge.source,
      target: edge.target,
      kind: (outgoing.get(edge.source) ?? 0) > 1 ? "branch" : "continue",
    }));

  return {
    activeSessionId,
    activeNodeId,
    activeNodeBySession,
    nodes: [...nodes.values()].map((node) => ({
      id: node.id,
      positionKey: node.positionKey,
      familyId: node.familyId,
      question: node.question,
      answer: node.answer,
      answerState: node.answerState,
      userEntryId: node.userEntryId,
      answerEntryId: node.answerEntryId,
      navigateEntryId: node.navigateEntryId,
      sessionIds: node.sessionIds,
      primarySessionId: node.primarySessionId,
      turnIndex: node.turnIndex,
      timestamp: node.timestamp,
      toolCallCount: node.toolCallCount,
    })),
    edges,
    truncated,
  };
}
