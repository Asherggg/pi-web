import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { translateNextDevToolsValue } = await createJiti(import.meta.url)
  .import("./NextDevToolsZh.tsx");

test("translates the visible Next.js indicator labels", () => {
  assert.equal(translateNextDevToolsValue("Open Next.js Dev Tools"), "打开 Next.js 开发工具");
  assert.equal(translateNextDevToolsValue("Rendering..."), "渲染中…");
  assert.equal(translateNextDevToolsValue("Route Info"), "路由信息");
  assert.equal(translateNextDevToolsValue("Preferences"), "偏好设置");
});

test("preserves whitespace around translated labels", () => {
  assert.equal(translateNextDevToolsValue("  Bundler\n"), "  打包器\n");
});

test("leaves whitespace and unrelated Shadow DOM content unchanged", () => {
  const whitespace = "\n    \n";
  const css = ":host { display: block; }";
  assert.equal(translateNextDevToolsValue(whitespace), whitespace);
  assert.equal(translateNextDevToolsValue(css), css);
});
