// Adapted from raylee-ai/lancer contracts/lancer-workflows.ts and lancer-modules.ts,
// commit 4dd8fe7134cd663a85f9a815ad90bb2685760da9 (MIT; see vendor/lancer-light-ui/NOTICE).
export interface WorkflowStep {
  title: string;
  model?: { provider: string; modelId: string };
  skills: string[];
  goal: string;
  deliverables: string;
}
export interface SessionWorkflow { moduleId: string; steps: WorkflowStep[]; activeStep?: number; disabled?: boolean }
export interface WorkbenchModule { id: string; name: string; description: string; steps: WorkflowStep[]; deleted?: boolean }
export interface WorkbenchState {
  version: 1;
  revision: number;
  modules: WorkbenchModule[];
  sessions: Record<string, SessionWorkflow>;
}
export class WorkbenchError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkbenchError("invalid");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new WorkbenchError("invalid");
  return value.trim();
}
export function decodeSteps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || !value.length || value.length > 8) throw new WorkbenchError("invalid");
  return value.map((raw) => {
    const s = record(raw);
    const skills = s.skills ?? [];
    if (!Array.isArray(skills) || skills.length > 12) throw new WorkbenchError("invalid");
    const model = s.model === undefined ? undefined : record(s.model);
    return { title: text(s.title, 40, true), skills: [...new Set(skills.map((x) => text(x, 256, true)))],
      goal: text(s.goal ?? "", 4000), deliverables: text(s.deliverables ?? "", 4000),
      ...(model ? { model: { provider: text(model.provider, 512, true), modelId: text(model.modelId, 512, true) } } : {}) };
  });
}
export function decodeModule(value: unknown): WorkbenchModule {
  const m = record(value);
  const id = text(m.id, 60, true);
  if (!/^[a-z0-9_-]+$/.test(id)) throw new WorkbenchError("invalid");
  if (m.deleted !== undefined && typeof m.deleted !== "boolean") throw new WorkbenchError("invalid");
  return { id, name: text(m.name, 40, true), description: text(m.description ?? "", 1000), steps: decodeSteps(m.steps), ...(m.deleted ? { deleted: true } : {}) };
}
export function decodeWorkflow(value: unknown): SessionWorkflow {
  const w = record(value);
  const steps = decodeSteps(w.steps);
  if (w.activeStep !== undefined && (!Number.isInteger(w.activeStep) || Number(w.activeStep) < 0 || Number(w.activeStep) >= steps.length)) throw new WorkbenchError("invalid");
  if (w.disabled !== undefined && typeof w.disabled !== "boolean") throw new WorkbenchError("invalid");
  return { moduleId: text(w.moduleId, 60), steps, ...(w.activeStep === undefined ? {} : { activeStep: Number(w.activeStep) }), ...(w.disabled ? { disabled: true } : {}) };
}
export function initialWorkbenchState(): WorkbenchState {
  const template = (id: string, name: string, titles: string[]): WorkbenchModule => ({ id, name, description: "", steps: titles.map((title) => ({ title, goal: "", deliverables: "", skills: [] })) });
  return { version: 1, revision: 0, modules: [
    template("development", "Development", ["Understand", "Implement", "Review", "Deliver"]),
    template("research", "Research", ["Collect", "Compare", "Verify", "Report"]),
    template("github", "Repository", ["Explore", "Read code", "Validate", "Report"]),
  ], sessions: Object.create(null) };
}
export function decodeWorkbenchState(value: unknown): WorkbenchState {
  const s = record(value);
  if (s.version !== 1 || !Number.isSafeInteger(s.revision) || Number(s.revision) < 0 || !Array.isArray(s.modules) || s.modules.length > 100) throw new WorkbenchError("corrupt", 409);
  const modules = s.modules.map(decodeModule);
  if (new Set(modules.map((m) => m.id)).size !== modules.length) throw new WorkbenchError("corrupt", 409);
  const sessions: Record<string, SessionWorkflow> = Object.create(null);
  const rawSessions = record(s.sessions);
  if (Object.keys(rawSessions).length > 5000) throw new WorkbenchError("limit", 409);
  for (const [id, workflow] of Object.entries(rawSessions)) {
    if (!validSessionId(id)) throw new WorkbenchError("corrupt", 409);
    sessions[id] = decodeWorkflow(workflow);
  }
  return { version: 1, revision: Number(s.revision), modules, sessions };
}
export function validSessionId(id: unknown): id is string { return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id) && !["__proto__", "constructor", "prototype"].includes(id); }
export type WorkbenchAction =
  | { type: "save-module"; module: WorkbenchModule }
  | { type: "toggle-module"; id: string; deleted: boolean }
  | { type: "assign"; sessionId: string; moduleId: string | null }
  | { type: "save-workflow"; sessionId: string; workflow: SessionWorkflow }
  | { type: "select-stage"; sessionId: string; index: number };
export function applyWorkbenchAction(state: WorkbenchState, input: unknown): WorkbenchState {
  const a = record(input);
  const next = structuredClone(state);
  if (a.type === "save-module") {
    const preset = decodeModule(a.module);
    if (next.modules.some((m) => m.id !== preset.id && !m.deleted && m.name === preset.name)) throw new WorkbenchError("duplicate");
    const i = next.modules.findIndex((m) => m.id === preset.id);
    if (i < 0) next.modules.push(preset); else next.modules[i] = preset;
  } else if (a.type === "toggle-module") {
    if (typeof a.deleted !== "boolean") throw new WorkbenchError("invalid");
    const preset = next.modules.find((m) => m.id === a.id);
    if (!preset) throw new WorkbenchError("missing", 404);
    preset.deleted = a.deleted;
  } else {
    if (!validSessionId(a.sessionId)) throw new WorkbenchError("invalid");
    const id = a.sessionId;
    if (a.type === "assign") {
      if (a.moduleId === null) {
        if (next.sessions[id]) next.sessions[id].disabled = true;
      } else {
        const preset = next.modules.find((m) => m.id === a.moduleId && !m.deleted);
        if (!preset) throw new WorkbenchError("missing", 404);
        const previous = next.sessions[id];
        next.sessions[id] = previous?.moduleId === preset.id ? { ...previous, disabled: false } : { moduleId: preset.id, steps: structuredClone(preset.steps) };
      }
    } else if (a.type === "save-workflow") {
      const workflow = decodeWorkflow(a.workflow);
      if (!next.modules.some((m) => m.id === workflow.moduleId && !m.deleted)) throw new WorkbenchError("missing", 404);
      next.sessions[id] = workflow;
    } else if (a.type === "select-stage") {
      const workflow = next.sessions[id];
      if (!workflow || workflow.disabled || !Number.isInteger(a.index) || Number(a.index) < 0 || Number(a.index) >= workflow.steps.length) throw new WorkbenchError("invalid");
      workflow.activeStep = Number(a.index);
    } else throw new WorkbenchError("invalid");
  }
  next.revision++;
  return decodeWorkbenchState(next);
}
export function workflowPrompt(step: WorkflowStep, skills: readonly { name: string; filePath: string; disableModelInvocation?: boolean }[], locale = "en"): string {
  if (!step.goal.trim()) throw new WorkbenchError("goalRequired");
  const selected = step.skills.map((name) => {
    const skill = skills.find((s) => s.name === name && !s.disableModelInvocation);
    if (!skill) throw new WorkbenchError("skillUnavailable");
    return skill;
  });
  const zh = locale.startsWith("zh");
  return [
    `${zh ? "执行阶段" : "Stage"}: ${step.title}`,
    `${zh ? "目标" : "Goal"}:\n${step.goal}`,
    selected.length ? `${zh ? "先读取并遵循以下技能说明" : "Read and follow the applicable skill instructions first"}:\n${selected.map((s) => `- ${s.name}: ${s.filePath}`).join("\n")}` : "",
    step.deliverables ? `${zh ? "交付与验收要求" : "Deliverables and acceptance"}:\n${step.deliverables}` : "",
    zh ? "沿用当前会话上下文，完成后说明交付物、验证结果与未解决的问题。" : "Continue with this session's context. Report deliverables, verification and unresolved issues.",
  ].filter(Boolean).join("\n\n");
}
