import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test, { mock } from 'node:test';
import { createJiti } from 'jiti';
import { control, reset, waitForCalls, execFile } from './__fixtures__/snapshot-git.mjs';
mock.method(childProcess, 'execFile', execFile); syncBuiltinESMExports();
test.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
const jiti = createJiti(import.meta.url);
const source = process.env.LANCER_CAPTURE_TEST_SOURCE ? resolve(process.env.LANCER_CAPTURE_TEST_SOURCE, 'lib/workbench') : dirname(fileURLToPath(import.meta.url));
const { captureTurnSnapshot } = await jiti.import(join(source, 'turn-snapshot-capture.ts'));
const { TURN_SNAPSHOT_LIMITS } = await jiti.import(join(source, 'turn-snapshot.ts'));
const nul = String.fromCharCode(0);
async function fixture(t, overrides = {}) {
  reset();
  const root = await mkdtemp(join(tmpdir(), 'snapshot-query-budget-'));
  await writeFile(join(root, 'source.txt'), 'source');
  const controller = new AbortController(); const blobs = [];
  t.after(async () => { controller.abort(); reset(); await rm(root, { recursive: true, force: true }); });
  const promise = captureTurnSnapshot(root, { ...TURN_SNAPSHOT_LIMITS, ...overrides }, async (hash, bytes) => blobs.push({ hash, bytes: bytes.toString() }), controller.signal);
  await waitForCalls(3);
  return { root, controller, blobs, promise, calls: Object.fromEntries(control.calls.map((call) => [call.kind, call])) };
}
test('checkout validation and both inventories start together before any content is read', async (t) => {
  const { promise, calls, blobs } = await fixture(t);
  assert.deepEqual(Object.keys(calls).sort(), ['ignored','paths','root']);
  assert.equal(blobs.length, 0);
  assert.equal(new Set(control.calls.map((call) => call.options.signal)).size, 1);
  for (const call of control.calls) {
    assert.equal(call.command, 'git');
    assert.ok(call.args.includes('core.fsmonitor=false'));
    assert.ok(call.options.timeout <= TURN_SNAPSHOT_LIMITS.timeoutMs);
  }
  calls.paths.release('source.txt'+nul); calls.ignored.release('private/'+nul);
  assert.equal(blobs.length, 0, 'inventory completion alone must not admit content');
  calls.root.release();
  const result = await promise;
  assert.equal(result.capture.state, 'complete');
  assert.deepEqual(result.excludedPaths, ['private/']);
  assert.deepEqual(blobs.map((blob) => blob.bytes), ['source']);
});
test('a different resolved checkout rejects inventories before reading any contents', async (t) => {
  const { root, promise, calls, blobs } = await fixture(t);
  calls.paths.release('source.txt'+nul); calls.ignored.release();
  calls.root.release(dirname(root)+String.fromCharCode(10));
  const result = await promise;
  assert.equal(result.capture.state, 'unavailable');
  assert.ok(result.capture.coverage.omitted['checkout-changing']);
  assert.equal(blobs.length, 0);
});
test('concurrent inventories share one byte cap and cancel pending validation on overflow', async (t) => {
  const { promise, calls, blobs } = await fixture(t, { maxInventoryBytes: 24 });
  calls.paths.release('source.txt'+nul);
  calls.ignored.release('private-a/'+nul+'private-b/'+nul);
  const result = await promise;
  assert.equal(result.capture.state, 'unavailable');
  assert.ok(result.capture.coverage.omitted['inventory-byte-limit']);
  assert.equal(calls.root.aborted, true);
  assert.equal(blobs.length, 0);
  assert.ok(control.calls.every((call) => call.settled));
});
test('one failed Git query aborts its siblings without waiting for the deadline', async (t) => {
  const { promise, calls, blobs } = await fixture(t);
  calls.paths.finish(Object.assign(new Error('inventory failed'), { code: 'EIO' }));
  const result = await promise;
  assert.equal(result.capture.state, 'unavailable');
  assert.equal(calls.root.aborted, true); assert.equal(calls.ignored.aborted, true);
  assert.equal(blobs.length, 0);
});
test('capture waits for cancelled sibling processes to close before returning', async (t) => {
  const { promise, calls } = await fixture(t);
  calls.root.holdClose = true; calls.ignored.holdClose = true;
  let returned = false; void promise.then(() => { returned = true; });
  calls.paths.finish(Object.assign(new Error('inventory failed'), { code: 'EIO' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.root.aborted, true); assert.equal(calls.ignored.aborted, true);
  assert.equal(returned, false, 'an abort callback does not prove the process has closed');
  calls.root.close(); calls.ignored.close();
  await promise;
  assert.ok(control.calls.every((call) => call.closed));
});
test('parent cancellation aborts all pending Git queries and never reads contents', async (t) => {
  const { promise, controller, blobs } = await fixture(t);
  controller.abort();
  const result = await promise;
  assert.ok(result.capture.coverage.omitted['capture-timeout-or-aborted']);
  assert.equal(blobs.length, 0); assert.ok(control.calls.every((call) => call.aborted));
});
test('store checkout preflight uses the named budget rather than a shorter hidden cutoff', async () => {
  const store = await readFile(join(source, 'turn-snapshot-store.ts'), 'utf8');
  assert.ok(store.includes('snapshotCheckoutRoot(cwd, TURN_SNAPSHOT_LIMITS.timeoutMs)'));
  assert.ok(store.includes('snapshotCheckoutRoot(input.cwd, TURN_SNAPSHOT_LIMITS.timeoutMs)'));
});
