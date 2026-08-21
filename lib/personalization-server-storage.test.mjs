import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  deleteStoredBackground,
  getPersonalizationDirectory,
  readStoredBackground,
  updateStoredBackgroundPreferences,
  writeStoredBackground,
} = await jiti.import("./personalization-server-storage.ts");

test("server backgrounds survive round trips and preference updates", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-personalization-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const metadata = writeStoredBackground(
    bytes,
    "桌面.png",
    "image/png",
    { strength: 0.42, fit: "contain" },
    agentDir,
  );
  assert.equal(metadata.name, "桌面.png");
  assert.deepEqual(readStoredBackground(agentDir), {
    bytes: Buffer.from(bytes),
    metadata,
  });

  const updated = updateStoredBackgroundPreferences({ strength: 0.7, fit: "cover" }, agentDir);
  assert.equal(updated.strength, 0.7);
  assert.equal(updated.fit, "cover");
  assert.deepEqual(readStoredBackground(agentDir).bytes, Buffer.from(bytes));

  const container = await readFile(path.join(getPersonalizationDirectory(agentDir), "background-image"));
  assert.equal(container.subarray(0, 6).toString("ascii"), "PIBG1\0");

  deleteStoredBackground(agentDir);
  assert.equal(readStoredBackground(agentDir), null);
});

test("server background storage rejects unsupported content types", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-personalization-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  assert.throws(
    () => writeStoredBackground(
      new Uint8Array([1]),
      "payload.svg",
      "image/svg+xml",
      { strength: 0.5, fit: "cover" },
      agentDir,
    ),
    /Unsupported image type/,
  );
});

test("corrupt or partial containers are ignored", async (t) => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-personalization-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const directory = getPersonalizationDirectory(agentDir);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "background-image"), "PIBG1\0\0");
  assert.equal(readStoredBackground(agentDir), null);
});
