/*
 * Capture safety adapted from raylee-ai/lancer 4dd8fe7134cd663a85f9a815ad90bb2685760da9,
 * apps/desktop/electron/workbench/checkpoint-store.ts; the private blob store is Pi Web's.
 *
 * MIT License
 * Copyright (c) 2026 Matthew Lam
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { TurnSnapshotError, type TurnSnapshotCapture, type TurnSnapshotCoverage, type TurnSnapshotLimits } from "./turn-snapshot";

export type SnapshotEntry =
  | { path: string; state: "text"; blob: string; size: number; executable: boolean }
  | { path: string; state: "missing" }
  | { path: string; state: "omitted"; reason: string };
export interface SnapshotManifest {
  version: 1;
  snapshotId: string;
  phase: "before" | "after";
  capture: TurnSnapshotCapture;
  entries: SnapshotEntry[];
}
export function emptyCoverage(state: TurnSnapshotCoverage["state"], note?: string): TurnSnapshotCoverage {
  return { state, scope: "tracked-and-nonignored-untracked", notes: note ? [note] : [], omitted: {} };
}
export function unavailableCapture(note: string): TurnSnapshotCapture {
  return {
    state: "unavailable", capturedAt: new Date().toISOString(), inventoryComplete: false,
    fileCount: 0, byteCount: 0, durationMs: 0, coverage: emptyCoverage("unavailable", note),
  };
}
export function pathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function safeSnapshotPath(path: unknown): path is string {
  return typeof path === "string" && path.length > 0 && path.length <= 4096
    && !/[\\\0:]/.test(path) && !isAbsolute(path)
    && !path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}
export function snapshotGitEnvironment(): NodeJS.ProcessEnv {
  // Strip all repository, index, config-injection and executable overrides, including case variants on Windows.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))) as NodeJS.ProcessEnv;
}
function git(cwd: string, args: string[], timeoutMs: number, maxBuffer: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((accept, reject) => {
    execFile("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd, env: snapshotGitEnvironment(), encoding: "buffer", timeout: Math.max(1, Math.ceil(timeoutMs)),
      maxBuffer, signal, killSignal: "SIGKILL", windowsHide: true,
    }, (error, stdout) => error ? reject(error) : accept(stdout));
  });
}
export async function snapshotCheckoutRoot(cwd: string, timeoutMs = 3000, signal?: AbortSignal): Promise<string> {
  const current = await realpath(cwd);
  const stat = await lstat(current);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TurnSnapshotError("checkout-unavailable", 422);
  let output: Buffer;
  try { output = await git(current, ["rev-parse", "--show-toplevel"], timeoutMs, 64 * 1024, signal); }
  catch { throw new TurnSnapshotError("checkout-unavailable", 422); }
  const decoded = output.toString("utf8");
  if (!Buffer.from(decoded).equals(output)) throw new TurnSnapshotError("checkout-unavailable", 422);
  const root = await realpath(decoded.replace(/\r?\n$/, ""));
  if (!isWithin(root, current)) throw new TurnSnapshotError("checkout-unavailable", 422);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new TurnSnapshotError("checkout-unavailable", 422);
  return root;
}
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameVersion(a: Stats, b: Stats): boolean {
  return sameIdentity(a, b) && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function missing(error: unknown): boolean {
  return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
}
class Omission extends Error {}

/** Only regular, stable inodes are read; every ancestor is checked before and after the read. */
async function inspectFile(root: string, rootStat: Stats, path: string, check: () => void, reserve: (bytes: number) => void): Promise<{ bytes: Buffer; executable: boolean } | null> {
  if (!safeSnapshotPath(path)) throw new Omission("unsafe-path");
  const absolute = resolve(root, path);
  if (!isWithin(root, absolute)) throw new Omission("unsafe-path");
  const ancestors = [{ path: root, stat: rootStat }];
  let parent = root;
  let inspected = false;
  try {
    for (const part of path.split("/").slice(0, -1)) {
      check();
      parent = join(parent, part);
      const stat = await lstat(parent);
      if (stat.isSymbolicLink()) throw new Omission("symlink");
      if (!stat.isDirectory()) throw new Omission("unsupported-file");
      ancestors.push({ path: parent, stat });
    }
    const before = await lstat(absolute);
    inspected = true;
    if (before.isSymbolicLink()) throw new Omission("symlink");
    if (!before.isFile()) throw new Omission("unsupported-file");
    reserve(before.size);
    check();
    const verifyAncestors = async () => {
      for (const ancestor of ancestors) {
        check();
        const current = await lstat(ancestor.path);
        if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(ancestor.stat, current)) throw new Omission("checkout-changing");
      }
    };
    const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat();
      // Check the descriptor before reading, including on platforms without O_NOFOLLOW.
      if (!opened.isFile() || !sameVersion(before, opened)) throw new Omission("checkout-changing");
      await verifyAncestors();
      if (pathKey(await realpath(absolute)) !== pathKey(absolute)) throw new Omission("symlink");
      const bytes = Buffer.alloc(before.size);
      for (let offset = 0; offset < bytes.length;) {
        check();
        const read = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
        if (!read.bytesRead) throw new Omission("checkout-changing");
        offset += read.bytesRead;
      }
      check();
      if (!sameVersion(before, await handle.stat()) || !sameVersion(before, await lstat(absolute))) throw new Omission("checkout-changing");
      await verifyAncestors();
      return { bytes, executable: Boolean(before.mode & 0o111) };
    } finally { await handle.close(); }
  } catch (error) {
    if (missing(error)) {
      if (!inspected) return null;
      throw new Omission("checkout-changing");
    }
    throw error;
  }
}
export async function captureTurnSnapshot(
  root: string, limits: TurnSnapshotLimits, putBlob: (hash: string, bytes: Buffer) => Promise<void>,
  parentSignal?: AbortSignal,
): Promise<{ capture: TurnSnapshotCapture; entries: SnapshotEntry[] }> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
  const entries: SnapshotEntry[] = [];
  const coverage = emptyCoverage("complete");
  let inventoryComplete = false;
  let fileCount = 0;
  let byteCount = 0;
  let reserved = 0;
  const check = () => {
    if (signal.aborted || performance.now() - started >= limits.timeoutMs) throw new Omission("capture-timeout-or-aborted");
  };
  const omit = (reason: string, path?: string) => {
    coverage.state = "partial";
    coverage.omitted[reason] = (coverage.omitted[reason] ?? 0) + 1;
    if (path) entries.push({ path, state: "omitted", reason });
  };
  try {
    check();
    const validatedRoot = await snapshotCheckoutRoot(root, Math.max(1, limits.timeoutMs - (performance.now() - started)), signal);
    if (pathKey(validatedRoot) !== pathKey(root)) throw new Omission("checkout-changing");
    const rootStat = await lstat(root);
    check();
    const output = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      limits.timeoutMs - (performance.now() - started), limits.maxInventoryBytes, signal);
    check();
    const text = output.toString("utf8");
    if (!Buffer.from(text).equals(output) || (text && !text.endsWith("\0"))) throw new Omission("inventory-invalid");
    const paths = [...new Set(text ? text.slice(0, -1).split("\0") : [])].sort();
    inventoryComplete = paths.length <= limits.maxFiles;
    if (!inventoryComplete) { coverage.omitted["file-limit"] = paths.length - limits.maxFiles; coverage.state = "partial"; }
    for (const path of paths.slice(0, limits.maxFiles)) {
      check();
      if (!safeSnapshotPath(path)) { inventoryComplete = false; omit("unsafe-or-nested-path"); continue; }
      try {
        const file = await inspectFile(root, rootStat, path, check, (size) => {
          if (size > limits.maxFileBytes) throw new Omission("file-byte-limit");
          if (reserved + size > limits.maxBytes) throw new Omission("total-byte-limit");
          reserved += size;
        });
        if (file === null) { entries.push({ path, state: "missing" }); continue; }
        const { bytes, executable } = file;
        if (bytes.includes(0)) throw new Omission("binary");
        if (!Buffer.from(bytes.toString("utf8")).equals(bytes)) throw new Omission("unsupported-encoding");
        check();
        const hash = createHash("sha256").update(bytes).digest("hex");
        await putBlob(hash, bytes);
        check();
        entries.push({ path, state: "text", blob: hash, size: bytes.length, executable });
        fileCount++;
        byteCount += bytes.length;
      } catch (error) {
        if (signal.aborted || performance.now() - started >= limits.timeoutMs) throw new Omission("capture-timeout-or-aborted");
        if (error instanceof Omission && error.message === "unsupported-file") inventoryComplete = false;
        omit(error instanceof Omission ? error.message : "file-unreadable", path);
      }
    }
    check();
    const currentRoot = await lstat(root);
    if (!currentRoot.isDirectory() || !sameIdentity(rootStat, currentRoot)) throw new Omission("checkout-changing");
  } catch (error) {
    inventoryComplete = false;
    omit(signal.aborted ? "capture-timeout-or-aborted" : error instanceof Omission ? error.message : "capture-failed");
  }
  if (!inventoryComplete && !entries.length) coverage.state = "unavailable";
  if (coverage.state !== "complete") coverage.notes.push("Some checkout files could not be captured; omitted or unknown contents are excluded from the diff.");
  return { entries, capture: {
    state: coverage.state, capturedAt: new Date().toISOString(), inventoryComplete,
    fileCount, byteCount, durationMs: Math.ceil(performance.now() - started), coverage,
  } };
}
