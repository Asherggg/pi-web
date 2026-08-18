import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_BACKGROUND_PREFERENCES,
  getBackgroundSurfaceAlphas,
  isAudioFile,
  isImageFile,
  parseBackgroundPreferences,
  parseSoundPreset,
  parseSoundVolume,
} from "./personalization.ts";

test("background preferences tolerate missing and malformed browser storage", () => {
  assert.deepEqual(parseBackgroundPreferences(null), DEFAULT_BACKGROUND_PREFERENCES);
  assert.deepEqual(parseBackgroundPreferences("not-json"), DEFAULT_BACKGROUND_PREFERENCES);
});

test("background preferences preserve valid values and clamp visibility", () => {
  assert.deepEqual(
    parseBackgroundPreferences(JSON.stringify({ strength: 0.64, fit: "contain", assetName: "desk.webp" })),
    { strength: 0.64, fit: "contain", assetName: "desk.webp" },
  );
  assert.equal(parseBackgroundPreferences(JSON.stringify({ strength: 4 })).strength, 0.8);
  assert.equal(parseBackgroundPreferences(JSON.stringify({ strength: -2 })).strength, 0.2);
});

test("wallpaper surfaces become more transparent as visibility increases", () => {
  const subtle = getBackgroundSurfaceAlphas(0.2);
  const prominent = getBackgroundSurfaceAlphas(0.8);
  assert.ok(prominent.surface < subtle.surface);
  assert.ok(prominent.panel < subtle.panel);
  assert.ok(prominent.panel > prominent.surface);
});

test("sound preferences accept supported values and clamp volume", () => {
  assert.equal(parseSoundPreset("soft"), "soft");
  assert.equal(parseSoundPreset("custom"), "custom");
  assert.equal(parseSoundPreset("unknown"), "classic");
  assert.equal(parseSoundVolume("1.8"), 1);
  assert.equal(parseSoundVolume("-0.2"), 0);
  assert.equal(parseSoundVolume("bad"), 1);
});

test("asset type checks fall back to common filename extensions", () => {
  assert.equal(isImageFile({ name: "background.WEBP", type: "" }), true);
  assert.equal(isImageFile({ name: "vector.svg", type: "image/svg+xml" }), false);
  assert.equal(isImageFile({ name: "notes.txt", type: "text/plain" }), false);
  assert.equal(isAudioFile({ name: "done.m4a", type: "" }), true);
  assert.equal(isAudioFile({ name: "script.js", type: "text/javascript" }), false);
});
