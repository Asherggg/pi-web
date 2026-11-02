"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useModuleWorkflow } from "@/hooks/useModuleWorkflow";
import { workflowPrompt, WorkbenchError, type WorkbenchModule, type SessionWorkflow } from "@/lib/workbench/workflow";
import { assignDraftModule } from "@/lib/workbench/draft-workflow";
import type { ChatInputHandle } from "../ChatInput";
import { ModuleWorkflowEditor, type WorkflowModel, type WorkflowSkill } from "./ModuleWorkflowEditor";
export function ModuleWorkflowBar({ sessionId, draftWorkflow, onDraftWorkflowChange, cwd, busy, models, currentModel, onModelChange, composerRef, treeOpen, onToggleTree }: {
  sessionId: string | null; draftWorkflow?: SessionWorkflow | null; onDraftWorkflowChange?: (workflow: SessionWorkflow | null) => void;
  cwd: string; busy: boolean; models: WorkflowModel[];
  currentModel?: { provider: string; modelId: string } | null;
  onModelChange: (provider: string, modelId: string) => Promise<boolean>;
  composerRef: React.RefObject<ChatInputHandle | null>; treeOpen: boolean; onToggleTree: () => void;
}) {
  const { t, locale } = useI18n();
  const { state, error: storageError, busy: saving, mutate } = useModuleWorkflow(sessionId ?? "draft");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [manage, setManage] = useState(false);
  const [editor, setEditor] = useState<{ module: WorkbenchModule; template: boolean } | null>(null);
  const [skills, setSkills] = useState<WorkflowSkill[]>([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const alive = useRef(true);
  const guard = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal }).then(async (r) => {
      if (!r.ok) throw new Error();
      const body = await r.json(); if (!controller.signal.aborted) { setSkills(body.skills ?? []); setSkillsLoaded(true); }
    }).catch(() => { if (!controller.signal.aborted) setSkillsLoaded(false); });
    return () => controller.abort();
  }, [cwd]);
  const workflow = sessionId ? state?.sessions[sessionId] : draftWorkflow;
  const saveWorkflow = async (next: SessionWorkflow) => {
    if (sessionId) await mutate({ type: "save-workflow", sessionId, workflow: next });
    else onDraftWorkflowChange?.(next);
  };
  const selectedModule = state?.modules.find((m) => m.id === workflow?.moduleId);
  const disabled = busy || saving || working || !state;
  const perform = async (operation: () => Promise<unknown>) => {
    if (guard.current) return;
    guard.current = true; setWorking(true); setError(null);
    try { await operation(); } catch (e) { if (alive.current) setError(e instanceof WorkbenchError ? e.code : "storage"); }
    finally { guard.current = false; if (alive.current) setWorking(false); }
  };
  const selectStage = async (index: number) => {
    if (disabled || !workflow) return;
    await perform(async () => {
      const step = workflow.steps[index];
      if (!step.model || !models.some((m) => m.provider === step.model?.provider && m.id === step.model.modelId)) throw new WorkbenchError("modelUnavailable");
      const switched = await onModelChange(step.model.provider, step.model.modelId);
      if (!alive.current) return;
      if (!switched) throw new WorkbenchError("modelFailed");
      if (sessionId) await mutate({ type: "select-stage", sessionId, index });
      else onDraftWorkflowChange?.({ ...workflow, activeStep: index });
    });
  };
  const loadTask = () => perform(async () => {
    if (!workflow || workflow.activeStep === undefined || busy) throw new WorkbenchError("busy");
    const step = workflow.steps[workflow.activeStep];
    if (step.model?.provider !== currentModel?.provider || step.model?.modelId !== currentModel?.modelId) throw new WorkbenchError("modelFailed");
    if (step.skills.length && !skillsLoaded) throw new WorkbenchError("skillLoadError");
    const prompt = workflowPrompt(step, skills, locale);
    if (!composerRef.current || composerRef.current.hasDraft()) throw new WorkbenchError("draftNotEmpty");
    if (!composerRef.current.insertIfEmpty(prompt)) throw new WorkbenchError("draftNotEmpty");
  });
  const moduleName = (m: WorkbenchModule) => ["development", "research", "github"].includes(m.id) && ["Development", "Research", "Repository"].includes(m.name) ? t(`workbench.template${m.id[0].toUpperCase()}${m.id.slice(1)}`) : m.name;
  return <div className="lancer-workflow-bar" data-workbench-source>
    <div className="lancer-workbench-toolbar">
      {sessionId && <button type="button" onClick={onToggleTree} aria-expanded={treeOpen} aria-controls="lancer-task-tree">{t("workbench.tree")}</button>}
      <select aria-label={t("workbench.module")} value={selectedModule && !selectedModule.deleted && !workflow?.disabled ? selectedModule.id : ""} disabled={disabled} onChange={(e) => { const moduleId = e.target.value || null; void perform(async () => {
        if (sessionId) await mutate({ type: "assign", sessionId, moduleId });
        else if (state) onDraftWorkflowChange?.(assignDraftModule(state, workflow ?? null, moduleId));
      }); }}>
        <option value="">{t("workbench.normal")}</option>{state?.modules.filter((m) => !m.deleted).map((m) => <option key={m.id} value={m.id}>{moduleName(m)}</option>)}
      </select>
      <button type="button" aria-expanded={manage} onClick={() => setManage(!manage)}>{t("workbench.manage")}</button>
      {workflow && !workflow.disabled && selectedModule && !selectedModule.deleted && <button type="button" disabled={disabled} onClick={() => setEditor({ module: selectedModule, template: false })}>{t("workbench.configure")}</button>}
    </div>
    {manage && <div className="lancer-module-manager">
      {state?.modules.map((m) => <div key={m.id} className="lancer-editor-row"><span>{moduleName(m)}{m.deleted ? ` · ${t("workbench.archived")}` : ""}</span><span><button disabled={disabled} onClick={() => setEditor({ module: m, template: true })}>{t("workbench.editModule")}</button><button disabled={disabled} onClick={() => { void perform(() => mutate({ type: "toggle-module", id: m.id, deleted: !m.deleted })); }}>{t(m.deleted ? "workbench.restoreModule" : "workbench.deleteModule")}</button></span></div>)}
      <button disabled={disabled} onClick={() => setEditor({ template: true, module: { id: `module-${crypto.randomUUID().slice(0, 8)}`, name: "", description: "", steps: [{ title: t("workbench.stage"), goal: "", deliverables: "", skills: [] }] } })}>{t("workbench.addModule")}</button>
    </div>}
    {workflow && !workflow.disabled && selectedModule && !selectedModule.deleted && <>
      <div className="lancer-stage-list" aria-label={t("workbench.stage")}>
        {workflow.steps.map((step, i) => <button key={i} type="button" disabled={disabled} aria-pressed={workflow.activeStep === i && step.model?.provider === currentModel?.provider && step.model?.modelId === currentModel?.modelId} onClick={() => { void selectStage(i); }} title={step.model ? `${step.model.provider}/${step.model.modelId}` : t("workbench.chooseModel")}><span>{i + 1}. {step.title}</span><small>{step.model?.modelId ?? t("workbench.chooseModel")}</small></button>)}
        <button type="button" disabled={disabled || workflow.activeStep === undefined} onClick={() => { void loadTask(); }}>{t("workbench.loadTask")}</button>
      </div><p className="lancer-help">{t("workbench.stageHint")}</p>
    </>}
    {selectedModule?.deleted && <p className="lancer-help">{t("workbench.deletedModuleHint")}</p>}
    {(error || storageError) && <p role="alert">{t(`workbench.${error ?? storageError}`)}</p>}
    {editor && <ModuleWorkflowEditor module={editor.module} template={editor.template} steps={editor.template ? editor.module.steps : workflow?.steps ?? editor.module.steps} models={models} skills={skills} onClose={() => setEditor(null)} onSave={async (saved) => {
      if (editor.template) await mutate({ type: "save-module", module: saved });
      else await saveWorkflow({ moduleId: saved.id, steps: saved.steps });
    }} />}
  </div>;
}
