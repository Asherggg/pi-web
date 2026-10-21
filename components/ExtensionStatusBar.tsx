"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem, McpToolCatalog } from "@/lib/types";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export interface McpStatusLabels {
  title: string;
  expand: string;
  collapse: string;
  loading: string;
  unavailable: string;
  noTools: string;
  toolCount: (count: number) => string;
  totalTools: (count: number) => string;
}
const DEFAULT_MCP_LABELS: McpStatusLabels = {
  title: "MCP tools", expand: "Show MCP tools", collapse: "Hide MCP tools",
  loading: "Loading MCP tools...", unavailable: "MCP tools are unavailable for this session.",
  noTools: "No tools loaded", toolCount: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
  totalTools: (count) => `${count} tools loaded`,
};

export const EXTENSION_STATUS_COMMAND_PREFIX = "command:";
export function extensionStatusCommand(key: string): string | null {
  if (!key.startsWith(EXTENSION_STATUS_COMMAND_PREFIX)) return null;
  const command = key.slice(EXTENSION_STATUS_COMMAND_PREFIX.length).trim();
  return command.length > 1 && command.startsWith("/") ? command : null;
}
export function sanitizeExtensionStatusText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim()).join("\n").trim();
}
function sortedStatuses(statuses: ExtensionStatusItem[]): ExtensionStatusItem[] {
  return [...statuses].sort((a, b) => a.key.localeCompare(b.key));
}
export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return sortedStatuses(statuses).map(({ text }) => sanitizeExtensionStatusText(text)).join(" ");
}
export function isMcpExtensionStatus(status: ExtensionStatusItem): boolean {
  return status.key.trim().toLowerCase() === "mcp";
}
type StatusCell =
  | { kind: "text"; text: string; mcp?: true }
  | { kind: "command"; command: string; label: string };
export function buildExtensionStatusCells(statuses: ExtensionStatusItem[]): StatusCell[] {
  const cells: StatusCell[] = [];
  for (const item of sortedStatuses(statuses)) {
    const text = sanitizeExtensionStatusText(item.text);
    const command = extensionStatusCommand(item.key);
    if (command) {
      const label = stripAnsi(text).replace(/\s+/g, " ").trim();
      cells.push({ kind: "command", command, label: label || command });
    } else if (stripAnsi(text).trim()) {
      cells.push({ kind: "text", text, ...(isMcpExtensionStatus(item) ? { mcp: true as const } : {}) });
    }
  }
  return cells;
}
interface StatusBarProps {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  onCommand?: (command: string) => void;
  commandsDisabled?: boolean;
  loadMcpTools?: () => Promise<McpToolCatalog | null>;
  mcpLabels?: McpStatusLabels;
}
interface McpControls {
  panel: ReactNode;
  panelId: string;
  expanded: boolean;
  toggle: () => void;
}

function renderStatusBar({ statuses, widgets = [], onCommand, commandsDisabled = false, mcpLabels = DEFAULT_MCP_LABELS }: StatusBarProps, mcp?: McpControls) {
  const cells = buildExtensionStatusCells(statuses);
  if (cells.length === 0 && widgets.length === 0) return null;
  const hasCommands = cells.some((cell) => cell.kind === "command");
  const plainStatusLine = cells.map((cell) => cell.kind === "text" ? stripAnsi(cell.text) : cell.label).join(" ");
  const statusLine = cells.length > 0 ? (
    <div role="status" className="extension-status-line" aria-label={plainStatusLine} title={plainStatusLine}>
      <span className="extension-status-text">
        {cells.map((cell, index) => cell.kind === "command" ? (
          <button key={index} type="button" className="extension-status-item extension-status-command"
            disabled={!onCommand || commandsDisabled} title={`${cell.label} · ${cell.command}`}
            aria-label={`${cell.label} (${cell.command})`} onClick={() => onCommand?.(cell.command)}>
            {cell.label}
          </button>
        ) : cell.mcp && mcp ? (
          <button key={index} type="button" className="extension-status-item extension-mcp-status-trigger"
            aria-controls={mcp.panelId} aria-expanded={mcp.expanded}
            aria-label={`${stripAnsi(cell.text)}. ${mcp.expanded ? mcpLabels.collapse : mcpLabels.expand}`}
            title={mcp.expanded ? mcpLabels.collapse : mcpLabels.expand} onClick={mcp.toggle}>
            <span><AnsiText text={cell.text} /></span><span className="extension-mcp-status-chevron" aria-hidden="true" />
          </button>
        ) : (
          <span key={index} className="extension-status-item"><AnsiText text={cell.text} /></span>
        ))}
      </span>
    </div>
  ) : null;
  return (
    <div className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${cells.length > 0 ? " has-status" : ""}${hasCommands ? " has-commands" : ""}`}>
      {mcp?.panel}
      {widgets.length > 0 ? <ExtensionWidgets widgets={widgets}>{statusLine}</ExtensionWidgets> : statusLine}
    </div>
  );
}

function McpStatusBar(props: StatusBarProps) {
  const labels = props.mcpLabels ?? DEFAULT_MCP_LABELS;
  const panelId = useId();
  const requestIdRef = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalog, setCatalog] = useState<McpToolCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (!props.loadMcpTools) { setError(labels.unavailable); return; }
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await props.loadMcpTools();
      if (requestIdRef.current !== requestId) return;
      setCatalog(next);
      if (!next) setError(labels.unavailable);
    } catch (cause) {
      if (requestIdRef.current !== requestId) return;
      setCatalog(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  };
  const panel = expanded ? (
    <section id={panelId} className="extension-mcp-panel" aria-label={labels.title}>
      <header className="extension-mcp-panel-header"><strong>{labels.title}</strong>{catalog && <span>{labels.totalTools(catalog.totalTools)}</span>}</header>
      {loading ? <div className="extension-mcp-panel-message">{labels.loading}</div>
        : error ? <div role="alert" className="extension-mcp-panel-message is-error">{error}</div>
        : catalog ? <div className="extension-mcp-server-list">
          {catalog.servers.map((server) => (
            <section key={server.name} className="extension-mcp-server">
              <div className="extension-mcp-server-heading"><strong>{server.name}</strong><span>{server.status} · {labels.toolCount(server.tools.length)}</span></div>
              {server.error && <div className="extension-mcp-server-error">{server.error}</div>}
              {server.tools.length > 0 ? <ul className="extension-mcp-tools">{server.tools.map((tool) => <li key={tool}>{tool}</li>)}</ul>
                : !server.error ? <div className="extension-mcp-empty">{labels.noTools}</div> : null}
            </section>
          ))}
          {catalog.servers.length === 0 && <div className="extension-mcp-panel-message">{labels.noTools}</div>}
        </div> : null}
    </section>
  ) : null;
  return renderStatusBar(props, { panel, panelId, expanded, toggle: () => void toggle() });
}

export function ExtensionStatusBar(props: StatusBarProps) {
  return props.statuses.some(isMcpExtensionStatus) ? <McpStatusBar {...props} /> : renderStatusBar(props);
}
