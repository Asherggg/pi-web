"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskGraph, TaskScope } from "@/lib/workbench/graph";

interface GraphView { owner: object; data: TaskGraph | null; error: string | null; loading: boolean }
export function useTaskGraph(sessionId: string, scope: TaskScope, enabled: boolean, refreshKey: number) {
  // Identity changes only for a new viewing generation, including close -> reopen.
  // A retained graph from the previous generation must never establish a light baseline.
  const owner = useMemo(() => ({ sessionId, scope, enabled }), [sessionId, scope, enabled]);
  const [view, setView] = useState<GraphView | null>(null);
  const [retry, setRetry] = useState(0);
  const request = useRef<(() => void) | null>(null);
  const lastSignal = useRef({ refreshKey, retry });
  useEffect(() => {
    const { enabled, sessionId, scope } = owner;
    if (!enabled) { request.current = null; return; }
    let closed = false, inFlight = false, queued = false, failures = 0;
    let controller: AbortController | null = null;
    let saved: TaskGraph | null = null;
    setView({ owner, data: null, error: null, loading: true });
    const update = async () => {
      if (closed || document.hidden) return;
      if (inFlight) { queued = true; return; }
      inFlight = true;
      controller = new AbortController();
      const activeController = controller;
      const timeout = setTimeout(() => activeController.abort(), 12000);
      try {
        const response = await fetch(`/api/workbench/graph?sessionId=${encodeURIComponent(sessionId)}&scope=${scope}`, { signal: activeController.signal, cache: "no-store" });
        const body = await response.json() as TaskGraph & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "historyError");
        if (!closed) {
          body.lanes = body.lanes.map((lane) => lane.error ? { ...lane, nodes: saved?.lanes.find((previous) => previous.session.id === lane.session.id)?.nodes ?? lane.nodes } : lane);
          saved = body; failures = 0;
          setView({ owner, data: body, error: null, loading: false });
        }
      } catch {
        if (!closed) { failures++; setView({ owner, data: saved, error: "historyError", loading: false }); }
      } finally {
        clearTimeout(timeout); inFlight = false;
        if (queued && !closed) { queued = false; void update(); }
      }
    };
    const refresh = () => { failures = 0; void update(); };
    request.current = refresh;
    void update();
    const tick = setInterval(() => { if (failures < 3) void update(); }, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      closed = true; queued = false;
      if (request.current === refresh) request.current = null;
      clearInterval(tick); controller?.abort(); document.removeEventListener("visibilitychange", refresh);
    };
    // Ordinary event/retry signals use the coalescing request below, not a new owner.
  }, [owner]);
  useEffect(() => {
    if (lastSignal.current.refreshKey === refreshKey && lastSignal.current.retry === retry) return;
    lastSignal.current = { refreshKey, retry };
    request.current?.();
  }, [refreshKey, retry]);
  const current = view?.owner === owner && enabled ? view : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: enabled && (current?.loading ?? true), refresh: useCallback(() => setRetry((value) => value + 1), []) };
}
