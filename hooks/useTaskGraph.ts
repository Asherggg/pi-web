"use client";
import { useEffect, useRef, useState } from "react";
import type { TaskGraph, TaskScope } from "@/lib/workbench/graph";
export function useTaskGraph(sessionId: string, scope: TaskScope, enabled: boolean, refreshKey: number) {
  const [data, setData] = useState<TaskGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const saved = useRef<TaskGraph | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    let failures = 0;
    setLoading(true); setData(null); saved.current = null;
    const update = async () => {
      if (closed || inFlight || document.hidden) return;
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12000);
      try {
        const response = await fetch(`/api/workbench/graph?sessionId=${encodeURIComponent(sessionId)}&scope=${scope}`, { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "historyError");
        if (!closed) {
          const previous = saved.current;
          // A failed lane keeps its last good nodes but always shows the current error.
          body.lanes = body.lanes.map((lane: TaskGraph["lanes"][number]) => lane.error ? { ...lane, nodes: previous?.lanes.find((p) => p.session.id === lane.session.id)?.nodes ?? lane.nodes } : lane);
          saved.current = body; setData(body); setError(null); failures = 0;
        }
      } catch { if (!closed) { failures++; setError("historyError"); } }
      finally { clearTimeout(timeout); inFlight = false; if (!closed) setLoading(false); }
    };
    void update();
    const tick = setInterval(() => { if (failures < 3) void update(); }, 5000);
    const focus = () => { failures = 0; void update(); };
    document.addEventListener("visibilitychange", focus);
    return () => { closed = true; clearInterval(tick); controller?.abort(); document.removeEventListener("visibilitychange", focus); };
  }, [sessionId, scope, enabled, refreshKey, retry]);
  return { data, error, loading, refresh: () => setRetry((n) => n + 1) };
}
