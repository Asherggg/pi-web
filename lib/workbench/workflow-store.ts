import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { readRegularFileText } from "../regular-file";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { serializeByKey } from "../key-serializer";
import { applyWorkbenchAction, decodeWorkbenchState, initialWorkbenchState, WorkbenchError, type WorkbenchState } from "./workflow";
export function workbenchStatePath(): string { return join(getAgentDir(), "pi-web-workbench.json"); }
export function readWorkbenchState(path = workbenchStatePath()): WorkbenchState {
  const raw = readRegularFileText(path, 4 * 1024 * 1024);
  if (raw === undefined) return initialWorkbenchState();
  try { return decodeWorkbenchState(JSON.parse(raw)); }
  catch { throw new WorkbenchError("corrupt", 409); }
}
export async function updateWorkbenchState(
  input: unknown, revision: number, path = workbenchStatePath(), beforeWrite?: () => void,
): Promise<WorkbenchState> {
  return serializeByKey(Symbol.for("pi-web:workbench-writes"), path, async () => {
    mkdirSync(dirname(path), { recursive: true });
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(path, { realpath: false, retries: { retries: 8, minTimeout: 25, maxTimeout: 250 }, onCompromised: () => {} });
      const current = readWorkbenchState(path);
      if (revision !== current.revision) throw new WorkbenchError("conflict", 409);
      const next = applyWorkbenchAction(current, input);
      beforeWrite?.();
      if (next === current) return next;
      const text = JSON.stringify(next, null, 2) + "\n";
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new WorkbenchError("limit", 413);
      writePrivateFileAtomicSync(path, text);
      return next;
    } finally { await release?.(); }
  });
}
