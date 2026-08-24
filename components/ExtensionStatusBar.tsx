"use client";

import { Fragment, useId, useRef, useState } from "react";
import { parseAnsiLine, stripAnsi } from "@/lib/ansi";
import type {
  ExtensionStatusItem,
  ExtensionWidgetItem,
  McpToolCatalog,
} from "@/lib/types";
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
  title: "MCP tools",
  expand: "Show MCP tools",
  collapse: "Hide MCP tools",
  loading: "Loading MCP tools...",
  unavailable: "MCP tools are unavailable for this session.",
  noTools: "No tools loaded",
  toolCount: (count) => `${count} ${count === 1 ? "tool" : "tools"}`,
  totalTools: (count) => `${count} tools loaded`,
};

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function isMcpExtensionStatus(status: ExtensionStatusItem): boolean {
  return status.key.trim().toLowerCase() === "mcp";
}

function StatusText({ text }: { text: string }) {
  return parseAnsiLine(sanitizeExtensionStatusText(text)).map((segment, index) => (
    <span key={index} style={segment.style}>{segment.text}</span>
  ));
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  loadMcpTools,
  mcpLabels = DEFAULT_MCP_LABELS,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  loadMcpTools?: () => Promise<McpToolCatalog | null>;
  mcpLabels?: McpStatusLabels;
}) {
  const panelId = useId();
  const requestIdRef = useRef(0);
  const [mcpExpanded, setMcpExpanded] = useState(false);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpCatalog, setMcpCatalog] = useState<McpToolCatalog | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  if (statuses.length === 0 && widgets.length === 0) return null;

  const sortedStatuses = [...statuses].sort((a, b) => a.key.localeCompare(b.key));
  const statusLine = formatExtensionStatusLine(statuses);
  const plainStatusLine = stripAnsi(statusLine);

  const toggleMcpTools = async () => {
    if (mcpExpanded) {
      setMcpExpanded(false);
      return;
    }
    setMcpExpanded(true);
    if (!loadMcpTools) {
      setMcpError(mcpLabels.unavailable);
      return;
    }

    const requestId = ++requestIdRef.current;
    setMcpLoading(true);
    setMcpError(null);
    try {
      const catalog = await loadMcpTools();
      if (requestIdRef.current !== requestId) return;
      if (!catalog) {
        setMcpCatalog(null);
        setMcpError(mcpLabels.unavailable);
      } else {
        setMcpCatalog(catalog);
      }
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setMcpCatalog(null);
      setMcpError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestIdRef.current === requestId) setMcpLoading(false);
    }
  };

  return (
    <div
      className={`extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${statuses.length > 0 ? " has-status" : ""}`}
    >
      {mcpExpanded && (
        <section id={panelId} className="extension-mcp-panel" aria-label={mcpLabels.title}>
          <header className="extension-mcp-panel-header">
            <strong>{mcpLabels.title}</strong>
            {mcpCatalog && <span>{mcpLabels.totalTools(mcpCatalog.totalTools)}</span>}
          </header>
          {mcpLoading ? (
            <div className="extension-mcp-panel-message">{mcpLabels.loading}</div>
          ) : mcpError ? (
            <div role="alert" className="extension-mcp-panel-message is-error">{mcpError}</div>
          ) : mcpCatalog ? (
            <div className="extension-mcp-server-list">
              {mcpCatalog.servers.map((server) => (
                <section key={server.name} className="extension-mcp-server">
                  <div className="extension-mcp-server-heading">
                    <strong>{server.name}</strong>
                    <span>{server.status} · {mcpLabels.toolCount(server.tools.length)}</span>
                  </div>
                  {server.error && (
                    <div className="extension-mcp-server-error">{server.error}</div>
                  )}
                  {server.tools.length > 0 ? (
                    <ul className="extension-mcp-tools">
                      {server.tools.map((tool) => <li key={tool}>{tool}</li>)}
                    </ul>
                  ) : !server.error ? (
                    <div className="extension-mcp-empty">{mcpLabels.noTools}</div>
                  ) : null}
                </section>
              ))}
              {mcpCatalog.servers.length === 0 && (
                <div className="extension-mcp-panel-message">{mcpLabels.noTools}</div>
              )}
            </div>
          ) : null}
        </section>
      )}
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} />}
      {statuses.length > 0 && (
        <div
          role="status"
          className="extension-status-line"
          aria-label={plainStatusLine}
          title={plainStatusLine}
        >
          <span className="extension-status-text">
            {sortedStatuses.map((status, index) => (
              <Fragment key={status.key}>
                {index > 0 && " "}
                {isMcpExtensionStatus(status) ? (
                  <button
                    type="button"
                    className="extension-mcp-status-trigger"
                    aria-controls={panelId}
                    aria-expanded={mcpExpanded}
                    aria-label={`${stripAnsi(sanitizeExtensionStatusText(status.text))}. ${mcpExpanded ? mcpLabels.collapse : mcpLabels.expand}`}
                    title={mcpExpanded ? mcpLabels.collapse : mcpLabels.expand}
                    onClick={() => void toggleMcpTools()}
                  >
                    <span><StatusText text={status.text} /></span>
                    <span className="extension-mcp-status-chevron" aria-hidden="true" />
                  </button>
                ) : (
                  <StatusText text={status.text} />
                )}
              </Fragment>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}
