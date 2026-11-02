"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { decodeModule, decodeSteps, WorkbenchError, type WorkbenchModule, type WorkflowStep } from "@/lib/workbench/workflow";
export interface WorkflowModel { id: string; provider: string; name: string }
export interface WorkflowSkill { name: string; filePath: string; disableModelInvocation?: boolean }
export function ModuleWorkflowEditor({ module, steps, template, models, skills, onSave, onClose }: {
  module: WorkbenchModule; steps: WorkflowStep[]; template: boolean; models: WorkflowModel[]; skills: WorkflowSkill[];
  onSave: (module: WorkbenchModule) => Promise<void>; onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(() => ({ ...module, steps: structuredClone(steps) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const update = (i: number, patch: Partial<WorkflowStep>) => setDraft((value) => ({ ...value, steps: value.steps.map((step, index) => index === i ? { ...step, ...patch } : step) }));
  const save = async () => {
    setBusy(true); setError(null);
    try { const checked = template ? decodeModule(draft) : { ...draft, steps: decodeSteps(draft.steps) }; await onSave(checked); onClose(); }
    catch (e) { setError(e instanceof WorkbenchError ? e.code : "storage"); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="lancer-editor" aria-labelledby="lancer-editor-title" onCancel={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); }} onKeyDown={(e) => { if (e.key === "Escape") e.stopPropagation(); }}>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <header><h2 id="lancer-editor-title">{t(template ? "workbench.editModule" : "workbench.editWorkflow")}</h2><button type="button" onClick={onClose} disabled={busy} aria-label={t("workbench.cancel")}>×</button></header>
      <fieldset disabled={busy}>
        {template && <><label>{t("workbench.moduleName")}<input value={draft.name} required maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>{t("workbench.description")}<textarea value={draft.description} maxLength={1000} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label></>}
        {draft.steps.map((step, i) => <section className="lancer-stage-editor" key={i}>
          <div className="lancer-editor-row"><strong>{t("workbench.stage")} {i + 1}</strong><button type="button" disabled={draft.steps.length === 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, n) => n !== i) })}>{t("workbench.removeStage")}</button></div>
          <label>{t("workbench.stageTitle")}<input required maxLength={40} value={step.title} onChange={(e) => update(i, { title: e.target.value })} /></label>
          <label>{t("workbench.model")}<select value={step.model ? `${step.model.provider}/${step.model.modelId}` : ""} onChange={(e) => { const model = models.find((m) => `${m.provider}/${m.id}` === e.target.value); update(i, { model: model ? { provider: model.provider, modelId: model.id } : undefined }); }}>
            <option value="">{t("workbench.chooseModel")}</option>
            {step.model && !models.some((m) => m.provider === step.model?.provider && m.id === step.model.modelId) && <option value={`${step.model.provider}/${step.model.modelId}`} disabled>{step.model.provider}/{step.model.modelId}</option>}
            {models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.provider} · {model.name}</option>)}
          </select></label>
          <label>{t("workbench.goal")}<textarea maxLength={4000} value={step.goal} onChange={(e) => update(i, { goal: e.target.value })} /></label>
          <label>{t("workbench.deliverables")}<textarea maxLength={4000} value={step.deliverables} onChange={(e) => update(i, { deliverables: e.target.value })} /></label>
          <div className="lancer-skill-options"><span>{t("workbench.skills")}</span>{skills.filter((s) => !s.disableModelInvocation).map((skill) => <label key={skill.name}><input type="checkbox" checked={step.skills.includes(skill.name)} disabled={!step.skills.includes(skill.name) && step.skills.length >= 12} onChange={(e) => update(i, { skills: e.target.checked ? [...step.skills, skill.name] : step.skills.filter((s) => s !== skill.name) })} />{skill.name}</label>)}{step.skills.filter((name) => !skills.some((s) => s.name === name && !s.disableModelInvocation)).map((name) => <label key={name}><input type="checkbox" checked onChange={() => update(i, { skills: step.skills.filter((s) => s !== name) })} />{name} — {t("workbench.skillUnavailable")}</label>)}</div>
        </section>)}
        <button type="button" disabled={draft.steps.length >= 8} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { title: `${t("workbench.stage")} ${draft.steps.length + 1}`, goal: "", deliverables: "", skills: [] }] })}>{t("workbench.addStage")}</button>
      </fieldset>
      {error && <p role="alert">{t(`workbench.${error}`)}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>{t("workbench.cancel")}</button><button type="submit" disabled={busy}>{t("workbench.save")}</button></footer>
    </form>
  </dialog>, document.body);
}
