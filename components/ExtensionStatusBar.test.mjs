import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  getExtensionStatusStateKey,
  isMcpExtensionStatus,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionStatusBar, props),
    ),
  );
}

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("preserves status line breaks while normalizing horizontal whitespace", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second\nthird",
  );
});

test("allows multiline status text to wrap and scroll within the footer", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const statusLineRule = css.match(/\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const statusTextRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(statusLineRule, /max-height:/);
  assert.match(statusLineRule, /overflow-y:\s*auto/);
  assert.match(statusTextRule, /overflow-wrap:\s*anywhere/);
  assert.match(statusTextRule, /white-space:\s*pre-wrap/);
  assert.doesNotMatch(statusTextRule, /text-overflow:\s*ellipsis/);
});

test("renders a single status line without identifier keys", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-shelf/);
  assert.match(html, /extension-status-line/);
  assert.match(html, /extension-status-text/);
  assert.match(html, />ponytail<\/span> <span><span style=/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("renders the MCP status as an expandable button", () => {
  assert.equal(isMcpExtensionStatus({ key: "mcp", text: "MCP: 4 servers enabled" }), true);
  assert.equal(isMcpExtensionStatus({ key: "memory", text: "memory" }), false);

  const html = renderStatusBar({
    statuses: [
      { key: "memory", text: "memory" },
      { key: "mcp", text: "MCP: 4 servers enabled" },
    ],
    loadMcpTools: async () => ({ servers: [], totalTools: 0 }),
  });

  assert.match(html, /extension-mcp-status-trigger/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Show MCP tools/);
  assert.match(html, /MCP: 4 servers enabled/);
  assert.doesNotMatch(html, /extension-mcp-panel/);
});

test("resets MCP catalog state when the MCP status disappears", async () => {
  assert.equal(getExtensionStatusStateKey([{ key: "mcp", text: "MCP ready" }]), "with-mcp");
  assert.equal(getExtensionStatusStateKey([{ key: "memory", text: "memory" }]), "without-mcp");

  const source = await readFile(new URL("./ExtensionStatusBar.tsx", import.meta.url), "utf8");
  assert.match(source, /<ExtensionStatusContent key=\{getExtensionStatusStateKey\(props\.statuses\)\}/);
});

test("renders widgets and status text in one footer", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{
      key: "usage",
      lines: ["42%"],
      placement: "aboveEditor",
    }],
  });

  assert.match(html, /extension-status-shelf has-widgets has-status/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /usage/);
  assert.match(html, /connected/);
});
