import { EventEmitter } from 'node:events';
const key = Symbol.for('pi-web:test:snapshot-git');
export const control = globalThis[key] ??= { calls: [], waiters: [] };
export function reset() {
  for (const call of control.calls) { if (!call.settled) call.finish(new Error('fixture reset')); call.close(); }
  control.calls = []; control.waiters = [];
}
export function waitForCalls(count) {
  if (control.calls.length >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Expected '+count+' concurrent Git queries; saw '+control.calls.length)), 1200);
    control.waiters.push(() => { if (control.calls.length >= count) { clearTimeout(timer); resolve(); } });
  });
}
export function execFile(command, args, options, callback) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const kind = args.includes('rev-parse') ? 'root' : args.includes('--ignored') ? 'ignored' : 'paths';
  const call = { command, args, options, kind, settled: false, aborted: false, closed: false, holdClose: false };
  call.close = () => { if (!call.closed) { call.closed = true; child.emit('close', call.aborted ? null : 0); } };
  const onAbort = () => { call.aborted = true; call.finish(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
  call.finish = (error, bytes = Buffer.alloc(0)) => {
    if (call.settled) return;
    call.settled = true; options.signal?.removeEventListener('abort', onAbort); callback(error, bytes, Buffer.alloc(0));
    if (!call.holdClose) queueMicrotask(call.close);
  };
  call.release = (value = kind === 'root' ? options.cwd+String.fromCharCode(10) : '') => {
    if (call.settled) return;
    const bytes = Buffer.from(value); stdout.emit('data', bytes);
    if (!call.settled) call.finish(null, bytes);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  control.calls.push(call);
  for (const wake of control.waiters) wake();
  if (options.signal?.aborted) queueMicrotask(onAbort);
  return Object.assign(child, { stdout, stderr: new EventEmitter(), kill: onAbort });
}
