"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { MarkdownBody } from "./MarkdownBody";
import { useI18n } from "@/hooks/useI18n";
import styles from "./SessionMap.module.css";
import type { SessionInfo } from "@/lib/types";
import type { SessionMapData, SessionMapNode } from "@/lib/session-map";
import {
  SESSION_MAP_CARD_HEIGHT,
  SESSION_MAP_CARD_WIDTH,
  layoutSessionMap,
  sessionMapConnectorPath,
  type SessionMapPosition,
} from "@/lib/session-map-layout";

interface SessionMapResponse extends SessionMapData {
  projectTitle: string;
}

interface Props {
  currentSessionId: string;
  onActivate: (session: SessionInfo, entryId: string, openChat: boolean) => Promise<void>;
  onFork: (session: SessionInfo, entryId: string) => Promise<void>;
  onClose: () => void;
}

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 4;
const POSITION_STORAGE_PREFIX = "pi-session-map:positions:v1:";

type Camera = { x: number; y: number };

function positionStorageKey(projectKey: string): string {
  return `${POSITION_STORAGE_PREFIX}${projectKey}`;
}

function loadSavedPositions(projectKey: string): Map<string, SessionMapPosition> {
  try {
    const raw = window.localStorage.getItem(positionStorageKey(projectKey));
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!Array.isArray(parsed)) return new Map();
    return new Map(parsed.filter((item): item is [string, SessionMapPosition] => (
      Array.isArray(item)
      && typeof item[0] === "string"
      && item[1] !== null
      && typeof item[1] === "object"
      && Number.isFinite((item[1] as SessionMapPosition).x)
      && Number.isFinite((item[1] as SessionMapPosition).y)
    )));
  } catch {
    return new Map();
  }
}

function savePositions(
  projectKey: string,
  positions: Map<string, SessionMapPosition>,
  nodes: SessionMapNode[],
): void {
  try {
    const persisted = nodes.flatMap((node) => {
      const position = positions.get(node.id);
      return position ? [[node.positionKey, position] as [string, SessionMapPosition]] : [];
    });
    window.localStorage.setItem(positionStorageKey(projectKey), JSON.stringify(persisted));
  } catch {
    // The active canvas remains usable when browser storage is unavailable.
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function sessionTitle(session: SessionInfo, fallback: string): string {
  return session.name || session.firstMessage || fallback;
}

export function SessionMap({ currentSessionId, onActivate, onFork, onClose }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<SessionMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, SessionMapPosition>>(new Map());
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [forkingNodeId, setForkingNodeId] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const positionsRef = useRef(positions);
  const initializedProjectRef = useRef<string | null>(null);
  const loadGenerationRef = useRef(0);
  const mapRequestControllerRef = useRef<AbortController | null>(null);
  const touchGestureRef = useRef<{
    camera: Camera;
    zoom: number;
    x: number;
    y: number;
    distance?: number;
    worldX?: number;
    worldY?: number;
  } | null>(null);

  useEffect(() => { positionsRef.current = positions; }, [positions]);

  const loadMap = useCallback(async (silent = false) => {
    const generation = ++loadGenerationRef.current;
    mapRequestControllerRef.current?.abort();
    const controller = new AbortController();
    mapRequestControllerRef.current = controller;
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/session-map?sessionId=${encodeURIComponent(currentSessionId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json() as SessionMapResponse & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      if (generation !== loadGenerationRef.current) return;
      setData(body);
      setActiveNodeId(body.activeNodeId);
      const automatic = layoutSessionMap(body.nodes, body.edges);
      const saved = loadSavedPositions(body.projectKey);
      for (const node of body.nodes) {
        const position = saved.get(node.positionKey);
        if (position) automatic.set(node.id, position);
      }
      positionsRef.current = automatic;
      setPositions(automatic);
      setError("");
    } catch (loadError) {
      if (controller.signal.aborted) return;
      if (generation === loadGenerationRef.current) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (mapRequestControllerRef.current === controller) mapRequestControllerRef.current = null;
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    void loadMap();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadMap(true);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [loadMap]);

  useEffect(() => () => {
    loadGenerationRef.current += 1;
    mapRequestControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      opener?.focus();
    };
  }, [onClose]);

  const focusNode = useCallback((nodeId: string | null, nextZoom = zoom) => {
    const viewport = viewportRef.current;
    if (!viewport || !nodeId) return;
    const position = positionsRef.current.get(nodeId);
    if (!position) return;
    const bounds = viewport.getBoundingClientRect();
    setCamera({
      x: bounds.width / 2 - (position.x + SESSION_MAP_CARD_WIDTH / 2) * nextZoom,
      y: bounds.height / 2 - (position.y + SESSION_MAP_CARD_HEIGHT / 2) * nextZoom,
    });
  }, [zoom]);

  useLayoutEffect(() => {
    if (!data || positions.size === 0 || initializedProjectRef.current === data.projectKey) return;
    initializedProjectRef.current = data.projectKey;
    const frame = window.requestAnimationFrame(() => focusNode(data.activeNodeId ?? data.nodes[0]?.id ?? null, 1));
    return () => window.cancelAnimationFrame(frame);
  }, [data, focusNode, positions.size]);

  const sessionById = useMemo(
    () => new Map((data?.sessions ?? []).map((session) => [session.id, session])),
    [data?.sessions],
  );

  const activateNode = useCallback(async (
    node: SessionMapNode,
    openChat: boolean,
    preferredSessionId?: string,
  ) => {
    const targetSessionId = preferredSessionId && node.sessionIds.includes(preferredSessionId)
      ? preferredSessionId
      : node.sessionIds.includes(currentSessionId)
        ? currentSessionId
        : node.primarySessionId;
    if (data?.runningSessionIds.includes(targetSessionId)) {
      setError(t("sessionMap.runningNavigate"));
      return;
    }
    const session = sessionById.get(targetSessionId);
    if (!session) return;
    setActiveNodeId(node.id);
    setError("");
    try {
      await onActivate(session, node.navigateEntryId, openChat);
    } catch (activationError) {
      setError(activationError instanceof Error ? activationError.message : String(activationError));
    }
  }, [currentSessionId, data?.runningSessionIds, onActivate, sessionById, t]);

  const activateSession = useCallback((session: SessionInfo) => {
    const nodeId = data?.activeNodeBySession[session.id];
    const node = (nodeId ? data?.nodes.find((candidate) => candidate.id === nodeId) : undefined)
      ?? (data?.nodes ?? []).filter((candidate) => candidate.sessionIds.includes(session.id)).at(-1);
    if (node) void activateNode(node, false, session.id);
  }, [activateNode, data]);

  const forkNode = useCallback(async (node: SessionMapNode) => {
    const targetSessionId = node.sessionIds.includes(currentSessionId)
      ? currentSessionId
      : node.primarySessionId;
    const session = sessionById.get(targetSessionId);
    const running = data?.runningSessionIds.includes(targetSessionId) ?? false;
    if (!session || forkingNodeId || running) return;
    setForkingNodeId(node.id);
    setError("");
    try {
      await onFork(session, node.answerEntryId ?? node.userEntryId);
    } catch (forkError) {
      setError(forkError instanceof Error ? forkError.message : String(forkError));
    } finally {
      setForkingNodeId(null);
    }
  }, [currentSessionId, data?.runningSessionIds, forkingNodeId, onFork, sessionById]);

  const zoomAt = useCallback((nextZoom: number, clientX: number, clientY: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(nextZoom * 100) / 100));
    if (clamped === zoom) return;
    const bounds = viewport.getBoundingClientRect();
    const localX = clientX - bounds.left;
    const localY = clientY - bounds.top;
    const worldX = (localX - camera.x) / zoom;
    const worldY = (localY - camera.y) / zoom;
    setZoom(clamped);
    setCamera({ x: localX - worldX * clamped, y: localY - worldY * clamped });
  }, [camera.x, camera.y, zoom]);

  const zoomAtCenter = useCallback((delta: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    zoomAt(zoom + delta, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
  }, [zoom, zoomAt]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest(`.${styles.card}`)) return;
    event.preventDefault();
    zoomAt(zoom + (event.deltaY < 0 ? 0.05 : -0.05), event.clientX, event.clientY);
  }, [zoom, zoomAt]);

  const handlePanStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if ((event.target as Element).closest(`.${styles.card}, button`)) return;
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY, camera };
    setPanning(true);
    const move = (moveEvent: PointerEvent) => {
      setCamera({
        x: origin.camera.x + moveEvent.clientX - origin.x,
        y: origin.camera.y + moveEvent.clientY - origin.y,
      });
    };
    const stop = () => {
      setPanning(false);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }, [camera]);

  const handleTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest(`.${styles.card}`)) return;
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    if (event.touches.length >= 2) {
      const first = event.touches[0];
      const second = event.touches[1];
      const x = (first.clientX + second.clientX) / 2 - bounds.left;
      const y = (first.clientY + second.clientY) / 2 - bounds.top;
      touchGestureRef.current = {
        camera,
        zoom,
        x,
        y,
        distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
        worldX: (x - camera.x) / zoom,
        worldY: (y - camera.y) / zoom,
      };
    } else if (event.touches.length === 1) {
      touchGestureRef.current = {
        camera,
        zoom,
        x: event.touches[0].clientX,
        y: event.touches[0].clientY,
      };
      setPanning(true);
    }
  }, [camera, zoom]);

  const handleTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = touchGestureRef.current;
    if (!gesture) return;
    event.preventDefault();
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (event.touches.length >= 2 && gesture.distance && gesture.worldX !== undefined && gesture.worldY !== undefined) {
      const first = event.touches[0];
      const second = event.touches[1];
      const bounds = viewport.getBoundingClientRect();
      const x = (first.clientX + second.clientX) / 2 - bounds.left;
      const y = (first.clientY + second.clientY) / 2 - bounds.top;
      const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(gesture.zoom * distance / gesture.distance * 100) / 100));
      setZoom(nextZoom);
      setCamera({ x: x - gesture.worldX * nextZoom, y: y - gesture.worldY * nextZoom });
    } else if (event.touches.length === 1 && gesture.distance === undefined) {
      setCamera({
        x: gesture.camera.x + event.touches[0].clientX - gesture.x,
        y: gesture.camera.y + event.touches[0].clientY - gesture.y,
      });
    }
  }, []);

  const handleTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 0) {
      touchGestureRef.current = null;
      setPanning(false);
    }
  }, []);

  const handleAnswerTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) return;
    event.stopPropagation();
    const answer = event.currentTarget;
    const startY = event.touches[0].clientY;
    const startScroll = answer.scrollTop;
    const move = (moveEvent: TouchEvent) => {
      if (moveEvent.touches.length !== 1) return;
      moveEvent.preventDefault();
      answer.scrollTop = startScroll + startY - moveEvent.touches[0].clientY;
    };
    const stop = () => {
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", stop);
      document.removeEventListener("touchcancel", stop);
    };
    document.addEventListener("touchmove", move, { passive: false });
    document.addEventListener("touchend", stop);
    document.addEventListener("touchcancel", stop);
  }, []);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>, nodeId: string) => {
    event.preventDefault();
    event.stopPropagation();
    const original = positionsRef.current.get(nodeId);
    if (!original || !data) return;
    const origin = { x: event.clientX, y: event.clientY, position: original };
    let latest = original;
    const move = (moveEvent: PointerEvent) => {
      latest = {
        x: Math.round(origin.position.x + (moveEvent.clientX - origin.x) / zoom),
        y: Math.round(origin.position.y + (moveEvent.clientY - origin.y) / zoom),
      };
      setPositions((current) => {
        const next = new Map(current);
        next.set(nodeId, latest);
        return next;
      });
    };
    const stop = () => {
      const next = new Map(positionsRef.current);
      next.set(nodeId, latest);
      positionsRef.current = next;
      savePositions(data.projectKey, next, data.nodes);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
  }, [data, zoom]);

  const moveNodeByKeyboard = useCallback((nodeId: string, dx: number, dy: number) => {
    if (!data) return;
    setPositions((current) => {
      const position = current.get(nodeId);
      if (!position) return current;
      const next = new Map(current);
      next.set(nodeId, { x: position.x + dx, y: position.y + dy });
      positionsRef.current = next;
      savePositions(data.projectKey, next, data.nodes);
      return next;
    });
  }, [data]);

  const resetLayout = useCallback(() => {
    if (!data) return;
    const automatic = layoutSessionMap(data.nodes, data.edges);
    positionsRef.current = automatic;
    setPositions(automatic);
    try { window.localStorage.removeItem(positionStorageKey(data.projectKey)); } catch { /* ignore */ }
    const frame = window.requestAnimationFrame(() => focusNode(activeNodeId ?? data.nodes[0]?.id ?? null));
    return () => window.cancelAnimationFrame(frame);
  }, [activeNodeId, data, focusNode]);

  return (
    <section ref={dialogRef} className={styles.overlay} role="dialog" aria-modal="true" aria-label={t("sessionMap.title")}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" />
            <path d="M7 6h10M6.5 7.5l4.2 8.7M17.5 7.5l-4.2 8.7" />
          </svg>
          <span>{t("sessionMap.brand")}</span>
        </div>
        <div className={styles.projectLabel}>{t("sessionMap.workspace")}</div>
        <div className={styles.projectName} title={data?.projectRoot}>{data?.projectTitle ?? t("i18n.loading")}</div>
        <div className={styles.sessionHeading}>{t("sessionMap.sessions")}</div>
        <nav className={styles.sessionList} aria-label={t("sessionMap.workspaceSessions")}>
          {(data?.sessions ?? []).map((session) => (
            <button
              key={session.id}
              type="button"
              className={`${styles.sessionRow} ${session.id === currentSessionId ? styles.sessionRowActive : ""}`}
              aria-current={session.id === currentSessionId ? "true" : undefined}
              onClick={() => activateSession(session)}
              title={sessionTitle(session, t("sessionMap.unnamed"))}
            >
              <span className={styles.sessionDot} />
              <span className={styles.sessionText}>{sessionTitle(session, t("sessionMap.unnamed"))}</span>
              {session.parentSessionId && <span className={styles.sessionBranch}>{t("sessionMap.branch")}</span>}
            </button>
          ))}
        </nav>
      </aside>

      <header className={styles.topbar}>
        <div className={styles.viewSwitch} role="group" aria-label={t("sessionMap.viewSwitch")}>
          <button type="button" onClick={onClose}>{t("sessionMap.chat")}</button>
          <button type="button" className={styles.activeSwitch} aria-pressed="true">{t("sessionMap.title")}</button>
        </div>
        <div className={styles.controls}>
          <button type="button" className={styles.controlButton} onClick={resetLayout} title={t("sessionMap.arrange")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            <span className={styles.controlText}>{t("sessionMap.arrange")}</span>
          </button>
          <button type="button" className={styles.controlButton} onClick={() => focusNode(activeNodeId)} title={t("sessionMap.focus")} aria-label={t("sessionMap.focus")}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
          </button>
          <button type="button" className={styles.controlButton} onClick={() => zoomAtCenter(-0.1)} title={t("sessionMap.zoomOut")} aria-label={t("sessionMap.zoomOut")}>−</button>
          <span className={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button type="button" className={styles.controlButton} onClick={() => zoomAtCenter(0.1)} title={t("sessionMap.zoomIn")} aria-label={t("sessionMap.zoomIn")}>+</button>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose} title={t("sessionMap.close")} aria-label={t("sessionMap.close")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 5l14 14M19 5 5 19" /></svg>
          </button>
        </div>
      </header>

      <main className={styles.stage}>
        {data?.truncated && <div className={styles.notice}>{t("sessionMap.truncated")}</div>}
        {error && <div className={styles.notice} role="alert">{error}</div>}
        {loading ? (
          <div className={styles.loading}>{t("sessionMap.loading")}</div>
        ) : !data || data.nodes.length === 0 ? (
          <div className={styles.empty}><strong>{t("sessionMap.emptyTitle")}</strong><span>{t("sessionMap.emptyBody")}</span></div>
        ) : (
          <div
            ref={viewportRef}
            className={`${styles.viewport} ${panning ? styles.viewportPanning : ""}`}
            onPointerDown={handlePanStart}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            onWheel={handleWheel}
          >
            <div className={styles.canvas} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})` }}>
              <svg className={styles.connectors} aria-hidden="true">
                {data.edges.map((edge) => {
                  const from = positions.get(edge.source);
                  const to = positions.get(edge.target);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={edge.id}
                      className={`${styles.connector} ${edge.kind === "branch" ? styles.connectorBranch : ""}`}
                      d={sessionMapConnectorPath(from, to)}
                    />
                  );
                })}
              </svg>
              <div className={styles.cards}>
                {data.nodes.map((node) => {
                  const position = positions.get(node.id);
                  if (!position) return null;
                  const isActive = node.id === activeNodeId;
                  const targetSessionId = node.sessionIds.includes(currentSessionId) ? currentSessionId : node.primarySessionId;
                  const session = sessionById.get(targetSessionId);
                  const targetRunning = data.runningSessionIds.includes(targetSessionId);
                  const isBranch = data.edges.some((edge) => edge.target === node.id && edge.kind === "branch");
                  return (
                    <article
                      key={node.id}
                      className={`${styles.card} ${isActive ? styles.cardActive : ""}`}
                      aria-current={isActive ? "true" : undefined}
                      style={{ left: position.x, top: position.y }}
                      onClick={(event) => {
                        if ((event.target as Element).closest("button") || window.getSelection()?.toString()) return;
                        void activateNode(node, false);
                      }}
                    >
                      <button
                        type="button"
                        className={styles.dragHandle}
                        onPointerDown={(event) => handleDragStart(event, node.id)}
                        onKeyDown={(event) => {
                          const step = event.shiftKey ? 50 : 10;
                          if (event.key === "ArrowLeft") moveNodeByKeyboard(node.id, -step, 0);
                          else if (event.key === "ArrowRight") moveNodeByKeyboard(node.id, step, 0);
                          else if (event.key === "ArrowUp") moveNodeByKeyboard(node.id, 0, -step);
                          else if (event.key === "ArrowDown") moveNodeByKeyboard(node.id, 0, step);
                          else return;
                          event.preventDefault();
                        }}
                        title={t("sessionMap.drag")}
                        aria-label={t("sessionMap.dragNode", { title: node.question })}
                      >···</button>
                      <header className={styles.cardHead}>
                        <span className={styles.topicDot} />
                        <span className={styles.question} tabIndex={0} title={node.question}>{node.question}</span>
                      </header>
                      <div className={styles.meta}>
                        <span className={isBranch ? styles.metaBranch : undefined}>{isBranch ? t("sessionMap.branch") : t("sessionMap.session")}</span>
                        <span>{t("sessionMap.turn", { count: node.turnIndex + 1 })}</span>
                        {node.toolCallCount > 0 && <span>{t("sessionMap.tools", { count: node.toolCallCount })}</span>}
                        <span>{formatTime(node.timestamp)}</span>
                      </div>
                      <div
                        className={`${styles.answer} ${node.answerState === "error" ? styles.errorAnswer : ""}`}
                        onTouchStart={handleAnswerTouchStart}
                      >
                        {node.answer ? <MarkdownBody>{node.answer}</MarkdownBody> : <p className={styles.emptyAnswer}>{t("sessionMap.waiting")}</p>}
                      </div>
                      <footer className={styles.cardFooter}>
                        <button type="button" disabled={targetRunning} title={targetRunning ? t("sessionMap.runningNavigate") : t("sessionMap.select")} onClick={() => void activateNode(node, false)}>{t("sessionMap.select")}</button>
                        <button type="button" disabled={forkingNodeId === node.id || !session || targetRunning} title={targetRunning ? t("sessionMap.runningFork") : t("sessionMap.createFork")} onClick={() => void forkNode(node)}>{forkingNodeId === node.id ? t("sessionMap.forking") : t("sessionMap.branch")}</button>
                        <button type="button" disabled={targetRunning} title={targetRunning ? t("sessionMap.runningNavigate") : t("sessionMap.openChat")} onClick={() => void activateNode(node, true)}>{t("sessionMap.openChat")}</button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>
    </section>
  );
}
