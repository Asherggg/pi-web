import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
const base = process.env.LANCER_TEST_BASE ?? "http://127.0.0.1:30143";
const out = resolve(process.env.LANCER_TEST_ARTIFACTS ?? "artifacts/lancer-light-fidelity/scope-layout");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const views = [];
try {
  await page.goto(`${base}/motion-fixture`, { waitUntil: "domcontentloaded" });
  await page.locator(".lancer-tree").waitFor();
  const selector = page.locator(".lancer-tree-controls select");
  for (const [scope, laneCount] of [["current", 1], ["family", 2], ["project", 3]]) {
    await selector.selectOption(scope);
    const panel = page.locator(`.lancer-tree-scope-${scope}`);
    await panel.waitFor();
    await assert.doesNotReject(() => page.waitForFunction(({ scope, laneCount }) => {
      const panel = document.querySelector(`.lancer-tree-scope-${scope}`);
      return panel?.querySelectorAll(".lancer-lane").length === laneCount;
    }, { scope, laneCount }));
    const measured = await page.evaluate(() => {
      const panel = document.querySelector(".lancer-tree");
      const content = panel.querySelector(".lancer-tree-scroll");
      const lanes = [...panel.querySelectorAll(".lancer-lane")];
      const node = panel.querySelector(".lancer-tree-node > button:first-of-type");
      return {
        panelWidth: panel.getBoundingClientRect().width,
        laneWidths: lanes.map((lane) => lane.getBoundingClientRect().width),
        nodeHeight: node.getBoundingClientRect().height,
        contentOverflowX: content.scrollWidth > content.clientWidth,
        pageOverflowX: document.documentElement.scrollWidth > innerWidth,
      };
    });
    assert.ok(measured.panelWidth >= 448, `${scope}: tree panel must retain the Lancer trajectory width`);
    assert.ok(measured.laneWidths.every((width) => width >= 220), `${scope}: lane columns became too narrow`);
    assert.ok(measured.nodeHeight >= 40, `${scope}: task nodes need a readable hit area`);
    assert.equal(measured.pageOverflowX, false, `${scope}: page must not overflow horizontally`);
    if (scope === "project") assert.equal(measured.contentOverflowX, true, "project lanes scroll inside the tree rather than compressing");
    await page.screenshot({ path: resolve(out, `${scope}-1440.png`) });
    views.push({ scope, laneCount, ...measured });
  }
  await page.setViewportSize({ width: 900, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".lancer-tree")).position === "absolute");
  const tablet = await page.evaluate(() => ({
    position: getComputedStyle(document.querySelector(".lancer-tree")).position,
    pageOverflowX: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.equal(tablet.position, "absolute");
  assert.equal(tablet.pageOverflowX, false);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    panelWidth: document.querySelector(".lancer-tree").getBoundingClientRect().width,
    pageOverflowX: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.equal(mobile.pageOverflowX, false);
  await page.screenshot({ path: resolve(out, "family-390.png") });
  assert.deepEqual(errors, []);
  const result = { passed: true, fixtureBacked: true, views, tablet, mobile, errors };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(out, "SCOPE_LAYOUT_RESULT.json"), JSON.stringify(result, null, 2));
  console.log("PASS: current/family/project tree layouts retain readable lane widths at desktop, tablet and mobile");
} catch (error) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(resolve(out, "SCOPE_LAYOUT_FAILURE.json"), JSON.stringify({ error: String(error), views, errors }, null, 2));
  throw error;
} finally { await browser.close(); }
