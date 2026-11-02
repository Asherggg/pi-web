import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TurnSnapshotStore, type TurnSnapshotHandle } from "./turn-snapshot-store";
import type { TurnSnapshotStatus } from "./turn-snapshot";

/** Public awaited boundaries: retries and automatic continuations retain the original baseline. */
export function createTurnSnapshotExtension(store = new TurnSnapshotStore()): ExtensionFactory {
  return (pi) => {
    const runtimeId = randomUUID();
    let active: TurnSnapshotHandle | null = null;
    let runObserved = false;
    let outcome: Exclude<TurnSnapshotStatus, "open" | "interrupted"> = "unknown";
    const failure = (error: unknown) => {
      console.warn("[pi-web] turn snapshot unavailable:", error instanceof Error ? error.message : "storage");
    };
    pi.on("agent_start", async (_event, ctx) => {
      if (runObserved) return;
      runObserved = true;
      outcome = "unknown";
      try {
        const id = ctx.sessionManager.getSessionId();
        if (!await store.isEnabled(id)) return;
        const file = ctx.sessionManager.getSessionFile();
        // Opt-in requires a real saved session. A deleted JSONL cannot keep recording through a stale wrapper.
        if (!file || !(await lstat(file)).isFile()) return;
        active = await store.begin({ sessionId: id, cwd: ctx.cwd, runtimeId, runId: randomUUID(), beforeEntryId: ctx.sessionManager.getLeafId() }, ctx.signal);
      } catch (error) { failure(error); }
    });
    pi.on("turn_end", (event) => {
      outcome = event.outcome === "completed" ? "completed" : event.outcome === "aborted" ? "stopped" : event.outcome === "error" ? "failed" : "unknown";
    });
    pi.on("agent_settled", async (event, ctx) => {
      const handle = active;
      active = null;
      runObserved = false;
      if (!handle) return;
      try {
        // Stop's signal is already aborted. The settled checkout still needs a complete final capture.
        await store.finish(handle, ctx.sessionManager.getLeafId(), event.aborted ? "stopped" : outcome);
      } catch (error) { failure(error); }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      const handle = active;
      active = null;
      runObserved = false;
      if (!handle) return;
      try { await store.finish(handle, ctx.sessionManager.getLeafId(), "interrupted"); }
      catch (error) { failure(error); }
    });
  };
}
