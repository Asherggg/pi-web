import { decodeWorkflow, WorkbenchError, type SessionWorkflow, type WorkbenchState } from "./workflow";

const PREFIX = "pi-web:lancer-workflow-draft:";

/** Per-composer UI data, kept apart from Pi's transcript and persistent workflow store. */
export function readWorkflowDraft(key: string): SessionWorkflow | null {
  try {
    const value = window.sessionStorage.getItem(PREFIX + key);
    return value ? decodeWorkflow(JSON.parse(value)) : null;
  } catch { return null; }
}
export function writeWorkflowDraft(key: string, workflow: SessionWorkflow | null): void {
  try {
    if (workflow) window.sessionStorage.setItem(PREFIX + key, JSON.stringify(workflow));
    else window.sessionStorage.removeItem(PREFIX + key);
  } catch { /* The in-memory composer remains usable when browser storage is unavailable. */ }
}
export function rekeyWorkflowDraft(previous: string, next: string): void {
  if (previous === next) return;
  const saved = readWorkflowDraft(previous);
  if (saved) writeWorkflowDraft(next, saved);
  writeWorkflowDraft(previous, null);
}

export function assignDraftModule(state: WorkbenchState, current: SessionWorkflow | null, moduleId: string | null): SessionWorkflow | null {
  if (moduleId === null) return current ? { ...current, disabled: true } : null;
  const preset = state.modules.find((m) => m.id === moduleId && !m.deleted);
  if (!preset) throw new WorkbenchError("missing", 404);
  return current?.moduleId === moduleId
    ? decodeWorkflow({ ...current, disabled: false })
    : { moduleId, steps: structuredClone(preset.steps) };
}

/** Attach the user's exact draft snapshot before dispatching the first prompt. No model calls. */
export async function persistInitialWorkflow(sessionId: string, workflow: SessionWorkflow): Promise<void> {
  const snapshot = decodeWorkflow(workflow);
  if (snapshot.disabled) return;
  const response = await fetch("/api/workbench/modules", { cache: "no-store" });
  const state = await response.json();
  if (!response.ok) throw new WorkbenchError(typeof state.error === "string" ? state.error : "storage", response.status);
  if (!Number.isSafeInteger(state.revision)) throw new WorkbenchError("storage", 500);
  const saved = await fetch("/api/workbench/modules", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: state.revision, action: { type: "save-workflow", sessionId, workflow: snapshot } }),
  });
  if (!saved.ok) {
    const failure = await saved.json().catch(() => ({}));
    throw new WorkbenchError(typeof failure.error === "string" ? failure.error : "storage", saved.status);
  }
}
