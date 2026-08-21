import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionMap.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("./SessionMap.module.css", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("keeps the map modal keyboard-contained and restores focus", () => {
  assert.match(source, /ref=\{dialogRef\}[\s\S]*?aria-modal="true"/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
  assert.match(source, /event\.key !== "Tab"/);
  assert.match(source, /opener\?\.focus\(\)/);
  assert.match(shellSource, /inert=\{sessionMapOpen \? true : undefined\}/);
});

test("supports mouse and touch canvas gestures", () => {
  assert.match(source, /onPointerDown=\{handlePanStart\}/);
  assert.match(source, /onTouchStart=\{handleTouchStart\}/);
  assert.match(source, /onTouchMove=\{handleTouchMove\}/);
  assert.match(source, /handleAnswerTouchStart/);
  assert.match(source, /Math\.min\(MAX_ZOOM, Math\.max\(MIN_ZOOM/);
});

test("accounts for the top safe area and hides the map sidebar on mobile", () => {
  assert.match(css, /grid-template-rows: calc\(44px \+ env\(safe-area-inset-top\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.sidebar \{[\s\S]*?display: none/);
});

test("marks current sessions and cards for assistive technology", () => {
  assert.match(source, /aria-current=\{session\.id === currentSessionId/);
  assert.match(source, /aria-current=\{isActive/);
  assert.match(source, /onKeyDown=\{\(event\) => \{[\s\S]*?ArrowLeft[\s\S]*?ArrowDown/);
});
