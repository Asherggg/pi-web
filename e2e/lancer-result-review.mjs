// Actual browser controls with isolated HTTP fixtures; no model requests or user state writes.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { initialWorkbenchState } = await jiti.import("../lib/workbench/workflow.ts");
const base = process.env.LANCER_TEST_BASE ?? "http://127.0.0.1:30141";
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-p4"); mkdirSync(out, { recursive: true });
const id = "lancer-review-parent", childId = "lancer-review-child";
const session = { id, name: "Review parent", cwd: process.cwd(), projectRoot: process.cwd(), projectKey: "review-project", path: "review-parent.jsonl", created: "2026-11-02T00:00:00Z", modified: "2026-11-02T00:00:00Z", messageCount: 2, firstMessage: "Inspect the result" };
const child = { ...session, id: childId, name: "Review worker", relation: { kind: "subagent", parentSessionId: id, profile: "fixture", description: "Review worker", status: "completed" } };
const evidence = { parentSessionId: id, childSessionId: childId, reportEntryId: "report", resultEntryId: "result", completedAt: session.created, status: "completed", text: "Verified report with two findings.\nThis is the full worker result.", fingerprint: "a".repeat(64), files: [], staleReview: false, latest: true, canReview: true };
let adoption, revision = 0, rejectNext = false, promptRequests = 0;
const decisions = [], errors = [];
let nextGraphGate, nextReviewGate;
function responseGate() {
  let release, entered;
  const wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  return { wait, started, release, entered };
}
let recording = false;
let reviewedPaths = [];
const snapId = "11111111-1111-4111-8111-111111111111";
const capture = { state: "complete", capturedAt: session.created, inventoryComplete: true, fileCount: 1, byteCount: 8, durationMs: 1, coverage: { state: "complete", scope: "tracked-and-nonignored-untracked", notes: [], omitted: {} } };
const snapshot = { snapshotId: snapId, sessionId: id, runId: snapId, runtimeId: snapId, checkoutPath: session.cwd, beforeEntryId: "call", afterEntryId: "report", startedAt: session.created, finishedAt: session.created, status: "completed", before: capture, after: capture, overlaps: [], overlapCount: 0, coverage: capture.coverage };
const graph = () => ({ sessionId: id, running: [], truncated: false, edges: [
  { id: "dispatch-edge", kind: "dispatch", parentSessionId: id, childSessionId: childId, sourceEntryId: "call", targetEntryId: "child-user" },
  { id: "return-edge", kind: "return", parentSessionId: id, childSessionId: childId, sourceEntryId: "result", targetEntryId: "report", reportEntryId: "report", adoption: evidence.staleReview ? undefined : adoption },
], lanes: [
  { session, truncated: false, nodes: [{ id: `${id}:call`, sessionId: id, entryId: "call", parentId: null, kind: "tools", text: "Delegate inspection", timestamp: session.created }, { id: `${id}:report`, sessionId: id, entryId: "report", reportEntryId: "report", parentId: `${id}:call`, kind: "report", text: "Worker report", timestamp: session.created, childSessionId: childId, completedAt: evidence.completedAt, reviewable: true, adoption, staleReview: evidence.staleReview }] },
  { session: child, truncated: false, nodes: [{ id: `${childId}:child-user`, sessionId: childId, entryId: "child-user", parentId: null, kind: "user", text: "Inspect", timestamp: session.created }, { id: `${childId}:result`, sessionId: childId, entryId: "result", parentId: `${childId}:child-user`, kind: "result", text: "Verified report", completedAt: evidence.completedAt, timestamp: session.created }] },
] });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
await page.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname; const method = route.request().method();
  const body = method === "POST" && route.request().postData() ? route.request().postDataJSON() : {};
  const json = (value, status = 200) => route.fulfill({ status, json: value });
  if (path === "/api/workbench/graph") {
    const gate = nextGraphGate; nextGraphGate = undefined;
    if (gate) { gate.entered(); await gate.wait; }
    return json(graph());
  }
  if (path === "/api/workbench/reviews") {
    if (method === "POST") {
      if (rejectNext) { rejectNext = false; evidence.fingerprint = "b".repeat(64); evidence.staleReview = true; return json({ error: "reportChanged" }, 409); }
      assert.equal(body.revision, revision); assert.equal(body.fingerprint, evidence.fingerprint);
      if (body.status === "accepted") assert.equal(adoption.status, "reviewed");
      decisions.push(body.status); revision++;
      adoption = { reportKey: `${id}|report`, parentSessionId: id, childSessionId: childId, resultEntryId: "result", fingerprint: body.fingerprint, status: body.status, updatedAt: session.modified, ...(body.note ? { note: body.note } : {}) };
      evidence.staleReview = false;
      const gate = nextReviewGate; nextReviewGate = undefined;
      if (gate) { gate.entered(); await gate.wait; }
    }
    return json({ evidence: { ...evidence, adoption }, revision });
  }
  if (path === "/api/workbench/modules") return json(initialWorkbenchState());
  if (path === "/api/workbench/snapshots") {
    if (method === "POST") recording = body.enabled;
    if (new URL(route.request().url()).searchParams.has("snapshotId")) return json({ ...snapshot, files: [{ path: "example.txt", kind: "modified", before: "original source", after: "verified edit" }], response: { truncated: false, omittedFiles: 0 } });
    return json({ enabled: recording, snapshots: recording ? [snapshot] : [] });
  }
  if (path === "/api/workbench/snapshot-reviews") {
    if (method === "POST") reviewedPaths = body.reviewed ? [body.path] : [];
    return json({ paths: reviewedPaths });
  }
  if (path === "/api/models") return json({ models: {}, modelList: [], defaultThinkingLevel: "medium", thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} });
  if (path === "/api/skills") return json({ skills: [], diagnostics: [], projectResourcesLoaded: true });
  if (path === "/api/sessions") return json({ sessions: [session, child], runningSessionIds: [], sessionListVersion: 0 });
  if (path === "/api/sessions/ui-state") return json({ version: 1, revision: 0, sessions: {}, projects: {} });
  if (path === `/api/sessions/${id}`) return json({ sessionId: id, filePath: session.path, info: session, leafId: "a", tree: [], snapshotRevision: "review-fixture", context: { messages: [{ role: "user", content: "Inspect the result" }, { role: "assistant", content: [{ type: "text", text: "Report ready" }] }], entryIds: ["u", "a"], oldestEntryId: "u", hasMore: false, turnsBefore: 0, thinkingLevel: "medium", model: null }, stats: { userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });
  if (path === `/api/sessions/${id}/state`) return json({ running: false, state: { isStreaming: false, isPromptRunning: false } });
  if (path === "/api/agent/running") return json({ runningSessionIds: [], awaitingInputSessionIds: [], sessionListVersion: 0, sessionUiStateRevision: 0 });
  if (path === `/api/agent/${id}/events`) return route.fulfill({ contentType: "text/event-stream", body: 'data: {"type":"connected","isStreaming":false}\n\n' });
  if (path.startsWith(`/api/agent/${id}`)) { if (body.type === "prompt") promptRequests++; return json(method === "POST" ? { success: true, data: {} } : { running: true, state: { isStreaming: false, isPromptRunning: false } }); }
  if (path === "/api/project-trust") return json({ trusted: true, requiresTrust: false, servers: [] });
  if (path === "/api/worktrees") return json({ isGit: false, worktrees: [], projectRoot: session.cwd });
  if (path === "/api/git/status") return json({ files: [] });
  if (path === "/api/file-index") return json({ files: [] });
  if (path.startsWith("/api/files/")) return json({ entries: [], path: session.cwd });
  if (path === "/api/app-update") return json({ updateAvailable: false, currentVersion: "0.13.0" });
  if (path === "/api/open-in-explorer") return json({ available: false });
  if (path === "/api/sessions/stats") return json({ stats: {} });
  return route.continue();
});
try {
  await page.goto(`${base}/?session=${id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Task tree", exact: true }).click();
  await page.locator('[data-task-edge="dispatch-edge"]').waitFor({ state: "attached" });
  await page.locator('[data-task-edge="return-edge"]').waitFor({ state: "attached" });
  assert.equal(await page.locator("[data-task-edge]").count(), 2);
  await page.getByRole("button", { name: "Pending review", exact: true }).last().click();
  const panel = page.getByRole("region", { name: "Review subtask result" });
  await panel.waitFor();
  assert.equal(await panel.getByRole("button", { name: "Accept result", exact: true }).isDisabled(), true);
  await panel.getByRole("textbox").fill("Keep this review open during graph refresh.");
  await page.evaluate(() => { window.__heldDispatch = document.querySelector('[data-task-edge="dispatch-edge"]'); });
  const graphGate = responseGate(); nextGraphGate = graphGate;
  try {
    await panel.getByRole("button", { name: "Mark reviewed", exact: true }).click();
    await graphGate.started;
    assert.equal(await page.evaluate(() => window.__heldDispatch?.isConnected && window.__heldDispatch === document.querySelector('[data-task-edge="dispatch-edge"]')), true, "refresh must retain existing graph DOM");
    assert.equal(await panel.isVisible(), true, "graph refresh must not close the review");
    assert.equal(await panel.getByRole("textbox").inputValue(), "Keep this review open during graph refresh.");
  } finally { graphGate.release(); }
  await page.locator('[data-task-edge="dispatch-edge"]').waitFor({ state: "attached" });
  await panel.getByRole("button", { name: "Accept result", exact: true }).click();
  await panel.getByText("Accepted", { exact: true }).waitFor();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".lancer-review-button").getByText("Accepted", { exact: true }).waitFor();
  await page.locator(".lancer-review-button").click();
  const currentPanel = page.getByRole("region", { name: "Review subtask result" });
  await currentPanel.getByRole("textbox").fill("Please add the missing benchmark.");
  const reviewGate = responseGate(); nextReviewGate = reviewGate;
  const saved = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/workbench/reviews" && response.request().method() === "POST");
  try {
    await currentPanel.getByRole("button", { name: "Request changes", exact: true }).click();
    await reviewGate.started;
    const scope = page.getByRole("combobox", { name: "Task tree", exact: true });
    await scope.selectOption(await scope.inputValue() === "current" ? "family" : "current");
    await currentPanel.waitFor({ state: "detached" });
  } finally { reviewGate.release(); }
  await saved;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await currentPanel.count(), 0, "a save from the previous scope must not reopen its review");
  await page.locator(".lancer-review-button").click();
  await currentPanel.getByText("Changes requested", { exact: true }).waitFor();
  await currentPanel.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.locator(".lancer-review-button").click();
  rejectNext = true;
  await page.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await page.getByText("This subtask has continued or its report/files changed.", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.locator(".lancer-review-button.is-stale").waitFor();
  await page.getByLabel("Record future runs", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.lancer-snapshot-toggle input')?.checked === true);
  await page.getByLabel("Select a recorded run", { exact: true }).selectOption(snapId);
  await page.getByText("original source", { exact: true }).waitFor();
  await page.getByText("verified edit", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Mark file reviewed", exact: true }).click();
  await page.getByRole("button", { name: "File reviewed", exact: true }).waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Select a recorded run", { exact: true }).selectOption(snapId);
  await page.getByRole("button", { name: "File reviewed", exact: true }).waitFor();
  assert.deepEqual(reviewedPaths, ["example.txt"]);
  await page.setViewportSize({ width: 390, height: 844 });
  // The responsive effect closes the drawer; do not race it with a coordinate click.
  await page.waitForFunction(() => document.querySelector('#session-sidebar')?.classList.contains('sidebar-closed'));
  await page.waitForFunction(() => document.querySelector('#session-sidebar').getBoundingClientRect().right <= 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: resolve(out, "result-review-mobile.png") });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: resolve(out, "result-review-desktop.png") });
  assert.deepEqual(decisions, ["reviewed", "accepted", "needs_changes"]); assert.equal(promptRequests, 0); assert.deepEqual(errors, []);
  writeFileSync(resolve(out, "REVIEW_BROWSER_RESULT.json"), JSON.stringify({ passed: true, fixtureBacked: true, decisions, promptRequests, errors, edgeCount: 2, checks: ["review-survives-pending-graph-refresh", "scope-change-discards-delayed-save-response", "dispatch-and-return-edges", "review-before-accept", "acceptance-survives-reload", "changes-require-note", "stale-evidence-rejected", "mobile-layout", "no-automatic-dispatch", "opt-in-turn-captures", "immutable-before-after-view", "file-review-survives-reload"] }, null, 2));
  console.log("PASS: result review, adoption, persisted status, stale rejection and two lineage edges; zero prompts");
} catch (error) {
  writeFileSync(resolve(out, "REVIEW_BROWSER_FAILURE.json"), JSON.stringify({ error: String(error), errors, body: (await page.locator("body").innerText()).slice(-8000) }, null, 2));
  await page.screenshot({ path: resolve(out, "result-review-failure.png") }); throw error;
} finally { await browser.close(); }
