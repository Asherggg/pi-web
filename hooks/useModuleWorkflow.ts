"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { WorkbenchError, type WorkbenchAction, type WorkbenchState } from "@/lib/workbench/workflow";
export function useModuleWorkflow(sessionId: string | null) {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(state); stateRef.current = state;
  const generation = useRef(0);
  const mutatePending = useRef(false);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    try {
      const response = await fetch("/api/workbench/modules", { signal, cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new WorkbenchError(body.error ?? "storage", response.status);
      if (generation.current === current) { stateRef.current = body; setState(body); setError(null); }
    } catch (e) { if (!signal?.aborted && generation.current === current) setError(e instanceof WorkbenchError ? e.code : "storage"); }
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void reload(controller.signal);
    const focus = () => { if (!mutatePending.current) void reload(controller.signal); };
    window.addEventListener("focus", focus);
    return () => { invalidate(); controller.abort(); window.removeEventListener("focus", focus); };
  }, [sessionId, reload, invalidate]);
  const mutate = useCallback(async (action: WorkbenchAction) => {
    if (!stateRef.current || mutatePending.current) throw new WorkbenchError("busy", 409);
    mutatePending.current = true; setBusy(true);
    const current = ++generation.current;
    try {
      const response = await fetch("/api/workbench/modules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: stateRef.current.revision, action }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "conflict" && generation.current === current) await reload();
        throw new WorkbenchError(body.error ?? "storage", response.status);
      }
      if (generation.current === current) { stateRef.current = body; setState(body); setError(null); }
      return body as WorkbenchState;
    } finally { mutatePending.current = false; setBusy(false); }
  }, [reload]);
  return { state, error, busy, reload, mutate };
}
