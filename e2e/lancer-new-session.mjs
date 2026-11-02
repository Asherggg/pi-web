// Actual browser UI, deterministic HTTP fixtures: no provider requests are sent.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initialWorkbenchState, applyWorkbenchAction } = await jiti.import("../lib/workbench/workflow.ts");
const base = process.env.LANCER_TEST_BASE ?? "http://127.0.0.1:30141";
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-next-step"); mkdirSync(out, { recursive: true });
const id = "lancer-new-composer-fixture", cwd = "D:/coding/pi-web-c";
const session = { id, cwd, projectRoot: cwd, projectKey: "d:/coding/pi-web-c", path: "fixture-new.jsonl", created: "2026-11-02T00:00:00Z", modified: "2026-11-02T00:00:00Z", messageCount: 1, firstMessage: "First task" };
const chosen = { provider: "fixture", modelId: "new-model" };
let state = initialWorkbenchState();
state.modules[0].steps = [{ title: "Investigate", model: chosen, skills: [], goal: "Template goal", deliverables: "Verified delivery" }];
let created = 0, writes = 0, sent = false;
const order = [], pageErrors = [];
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => pageErrors.push(error.message));
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  const body = route.request().method() === "POST" ? route.request().postDataJSON() : null;
  const json = (value) => route.fulfill({ json: value });
  if (path === "/api/workbench/modules") {
    if (body) { writes++; order.push("save-workflow"); state = applyWorkbenchAction(state, body.action); }
    return json(state);
  }
  if (path === "/api/cwd/validate") return json({ success: true, cwd, projectRoot: cwd, projectKey: session.projectKey });
  if (path === "/api/models") return json({ models: { "fixture/new-model": "New model" }, modelList: [{ provider: "fixture", id: "new-model", name: "New model" }, { provider: "fixture", id: "fallback", name: "Default model" }], defaultModel: { provider: "fixture", modelId: "fallback" }, defaultThinkingLevel: "medium", thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} });
  if (path === "/api/skills") return json({ skills: [], diagnostics: [], projectResourcesLoaded: true });
  if (path === "/api/sessions") return json({ sessions: sent ? [session] : [], runningSessionIds: [], sessionListVersion: sent ? 1 : 0 });
  if (path === "/api/sessions/ui-state") return json({ version: 1, revision: 0, sessions: {}, projects: {} });
  if (path === "/api/agent/running") return json({ runningSessionIds: [], awaitingInputSessionIds: [], sessionListVersion: sent ? 1 : 0, sessionUiStateRevision: 0 });
  if (path === "/api/agent/new") { created++; order.push("ensure-session"); assert.equal(body.provider, chosen.provider); assert.equal(body.modelId, chosen.modelId); return json({ success: true, sessionId: id, model: chosen, thinkingLevel: "medium" }); }
  if (path === `/api/agent/${id}/events`) return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify({ type: "connected", sessionId: id, isStreaming: false })}\n\n` });
  if (path === `/api/agent/${id}`) {
    if (body) { if (body.type === "prompt") { sent = true; order.push("prompt"); assert.ok(state.sessions[id], "Workflow must exist before the first prompt"); } return json({ success: true, data: null }); }
    return json({ running: false, state: { isStreaming: false, isPromptRunning: false, model: { provider: "fixture", id: "new-model" } } });
  }
  if (path.endsWith(`/sessions/${id}/state`)) return json({ running: false, state: {} });
  if (path === `/api/sessions/${id}`) return json({ sessionId: id, filePath: session.path, info: session, leafId: "u", tree: [], snapshotRevision: "new-fixture", context: { messages: [{ role: "user", content: "First task" }], entryIds: ["u"], oldestEntryId: "u", hasMore: false, turnsBefore: 0, thinkingLevel: "medium", model: chosen }, stats: { userMessages: 1, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });
  if (path === "/api/worktrees") return json({ isGit: false, worktrees: [], projectRoot: cwd });
  if (path === "/api/project-trust") return json({ requiresTrust: false, trusted: true, servers: [] });
  if (path === "/api/git/status") return json({ files: [] });
  if (path === "/api/file-index") return json({ files: [] });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: cwd });
  if (path === "/api/app-update") return json({ updateAvailable: false, currentVersion: "0.13.0" });
  if (path === "/api/open-in-explorer") return json({ available: false });
  return route.continue();
});
try {
  await page.goto(`${base}/?cwd=${encodeURIComponent(cwd)}`, { waitUntil: "domcontentloaded" });
  const modulePicker = page.getByLabel("Module", { exact: true });
  await modulePicker.waitFor({ timeout: 30000 });
  await modulePicker.selectOption("development");
  await page.getByRole("button", { name: "Configure stages", exact: true }).click();
  await page.getByLabel("Goal", { exact: true }).fill("A new-session-specific goal");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "1. Investigate" }).click();
  await page.getByRole("button", { name: "Load task", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-input-textarea')?.value.includes('A new-session-specific goal'));
  assert.equal(created, 0); assert.equal(writes, 0); assert.equal(sent, false);
  assert.equal(state.modules[0].steps[0].goal, "Template goal");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "1. Investigate" }).waitFor();
  assert.equal(await modulePicker.inputValue(), "development");
  // Pi Web's composer drafts are page-memory data. The saved stage can be loaded again after a reload.
  await page.getByRole("button", { name: "Load task", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-input-textarea')?.value.includes('A new-session-specific goal'));
  assert.equal(created, 0);
  await page.screenshot({ path: resolve(out, "new-session-workflow-desktop.png") });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => new URLSearchParams(location.search).get('session') === 'lancer-new-composer-fixture');
  assert.equal(created, 1); assert.equal(writes, 1);
  assert.deepEqual(order, ["ensure-session", "save-workflow", "prompt"]);
  assert.equal(state.sessions[id].steps[0].goal, "A new-session-specific goal");
  assert.equal(state.sessions[id].activeStep, 0);
  assert.equal(state.modules[0].steps[0].goal, "Template goal");
  assert.deepEqual(pageErrors, []);
  writeFileSync(resolve(out, "NEW_SESSION_BROWSER_RESULT.json"), JSON.stringify({ passed: true, fixtureBacked: true, created, writes, order, pageErrors, checks: ["new-session-module-picker", "local-stage-editor", "template-copy", "no-start-before-send", "stage-model", "load-task", "reload-preserves-plan", "reload-preserves-stage-model", "reload-task-from-saved-stage", "persist-before-first-prompt", "promotion-keeps-plan"] }, null, 2));
  console.log("PASS: new-session module selection, draft restoration, and workflow inheritance before the first prompt");
} catch (error) {
  writeFileSync(resolve(out, "NEW_SESSION_BROWSER_FAILURE.json"), JSON.stringify({ error: String(error), pageErrors, order, body: (await page.locator("body").innerText()).slice(-9000) }, null, 2));
  await page.screenshot({ path: resolve(out, "new-session-workflow-failure.png") });
  throw error;
} finally { await browser.close(); }
