"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TurnSnapshotList, TurnSnapshotDetail } from "@/lib/workbench/turn-snapshot";

export function TurnSnapshotPanel({ sessionId, running }: { sessionId: string; running: boolean }) {
  const { t, locale } = useI18n();
  const [list, setList] = useState<TurnSnapshotList | null>(null);
  const [detail, setDetail] = useState<TurnSnapshotDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [reviewed, setReviewed] = useState<string[]>([]);
  const generation = useRef(0);
  const mounted = useRef(true);
  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`/api/workbench/snapshots?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store", signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "storage");
      if (!signal?.aborted && mounted.current) { setList(body); setError(null); }
    } catch (cause) { if (!signal?.aborted && mounted.current) setError(cause instanceof Error ? cause.message : "storage"); }
  }, [sessionId]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [reload, running]);
  const toggle = async () => {
    if (!list) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/workbench/snapshots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, action: "set-enabled", enabled: !list.enabled }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "storage");
      if (mounted.current) setList(body);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "storage"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const select = async (id: string) => {
    const current = ++generation.current;
    setBusy(true); setError(null); setDetail(null); setReviewed([]);
    try {
      const response = await fetch(`/api/workbench/snapshots?${new URLSearchParams({ sessionId, snapshotId: id })}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "storage");
      const marks = await fetch(`/api/workbench/snapshot-reviews?${new URLSearchParams({ sessionId, snapshotId: id })}`, { cache: "no-store" });
      const reviewedBody = await marks.json();
      if (!marks.ok) throw new Error(reviewedBody.error ?? "storage");
      if (mounted.current && generation.current === current) { setDetail(body); setSelectedPath(body.files[0]?.path ?? ""); setReviewed(reviewedBody.paths); }
    } catch (cause) { if (mounted.current && generation.current === current) setError(cause instanceof Error ? cause.message : "storage"); }
    finally { if (mounted.current && generation.current === current) setBusy(false); }
  };
  const mark = async () => {
    if (!detail || !selectedPath) return;
    setBusy(true);
    try {
      const response = await fetch("/api/workbench/snapshot-reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, snapshotId: detail.snapshotId, path: selectedPath, reviewed: !reviewed.includes(selectedPath) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "storage");
      if (mounted.current) setReviewed(body.paths);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "storage"); }
    finally { if (mounted.current) setBusy(false); }
  };
  const file = detail?.files.find((item) => item.path === selectedPath);
  return <section className="lancer-snapshots" aria-label={t("workbench.snapshots.title")}>
    <header><h3>{t("workbench.snapshots.title")}</h3><button disabled={busy} onClick={() => { void reload(); }} aria-label={t("workbench.snapshots.refresh")}>↻</button></header>
    <label className="lancer-snapshot-toggle"><input type="checkbox" checked={list?.enabled ?? false} disabled={busy || !list} onChange={() => { void toggle(); }} />{t("workbench.snapshots.record")}</label>
    <p className="lancer-help">{t("workbench.snapshots.futureOnly")}</p>
    {error && <p role="alert">{t(`workbench.snapshotError.${error}`) === `workbench.snapshotError.${error}` ? t("workbench.snapshotError.storage") : t(`workbench.snapshotError.${error}`)}</p>}
    {list && !list.snapshots.length && <p>{t("workbench.snapshots.empty")}</p>}
    {!!list?.snapshots.length && <select aria-label={t("workbench.snapshots.select")} disabled={busy} value={detail?.snapshotId ?? ""} onChange={(event) => { if (event.target.value) void select(event.target.value); }}>
      <option value="">{t("workbench.snapshots.select")}</option>
      {list.snapshots.map((snapshot) => <option key={snapshot.snapshotId} value={snapshot.snapshotId}>{new Date(snapshot.startedAt).toLocaleString(locale)} · {t(`workbench.snapshotStatus.${snapshot.status}`)} · {t(`workbench.snapshotCoverage.${snapshot.coverage.state}`)}</option>)}
    </select>}
    {detail && <>
      <p>{t(`workbench.snapshotCoverage.${detail.coverage.state}`)} · {t(`workbench.snapshotStatus.${detail.status}`)}</p>
      {detail.coverage.notes.length > 0 && <details><summary>{t("workbench.snapshots.coverage")}</summary>{detail.coverage.notes.map((note) => <p key={note}>{note}</p>)}</details>}
      {!!detail.overlapCount && <p role="status">{t("workbench.snapshots.overlap")}</p>}
      <p className="lancer-help">{t("workbench.snapshots.provenance")} {detail.beforeEntryId?.slice(0, 12) || "—"} → {detail.afterEntryId?.slice(0, 12) || "—"}</p>
      {!detail.files.length && <p>{t(detail.coverage.state === "unavailable" ? "workbench.snapshots.unavailable" : "workbench.snapshots.noChanges")}</p>}
      {!!detail.files.length && <><select aria-label={t("workbench.snapshots.file")} value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}>{detail.files.map((item) => <option key={item.path} value={item.path}>{reviewed.includes(item.path) ? "✓ " : ""}{item.path} · {t(`workbench.snapshotFile.${item.kind}`)}</option>)}</select>
        {file && <><button disabled={busy} aria-pressed={reviewed.includes(file.path)} onClick={() => { void mark(); }}>{t(reviewed.includes(file.path) ? "workbench.snapshots.reviewed" : "workbench.snapshots.markReviewed")}</button><div className="lancer-snapshot-diff"><section><h4>{t("i18n.before")}</h4><pre>{file.before ?? t("workbench.snapshots.absent")}</pre></section><section><h4>{t("i18n.after")}</h4><pre>{file.after ?? t("workbench.snapshots.absent")}</pre></section></div></>}
      </>}
      {detail.response.truncated && <p role="status">{t("workbench.snapshots.truncated")}</p>}
    </>}
  </section>;
}
