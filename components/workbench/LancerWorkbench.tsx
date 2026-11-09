"use client";
import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import type { SessionInfo } from "@/lib/types";
import type { TaskScope } from "@/lib/workbench/graph";
import { useTaskGraph } from "@/hooks/useTaskGraph";
import { useTaskLights } from "@/hooks/useTaskLights";
import { taskLaneColor } from "@/hooks/task-light-anchors";
import { ModuleWorkflowBar } from "./ModuleWorkflowBar";
import { TaskTreePanel } from "./TaskTreePanel";
import type { WorkflowModel } from "./ModuleWorkflowEditor";
import type { ChatInputHandle } from "../ChatInput";
import type { SessionWorkflow } from "@/lib/workbench/workflow";
import "./workbench.css";
interface Props {
  enabled?: boolean;
  session: SessionInfo | null; newSessionCwd?: string | null; newSessionDraftKey?: string | null;
  draftWorkflow?: SessionWorkflow | null; onDraftWorkflowChange?: (workflow: SessionWorkflow | null) => void;
  busy: boolean; eventVersion?: number; models: WorkflowModel[];
  currentModel?: { provider: string; modelId: string } | null;
  onModelChange: (provider: string, modelId: string) => Promise<boolean>;
  composerRef: React.RefObject<ChatInputHandle | null>; children: ReactNode;
  onNavigate?: (session: SessionInfo, entryId: string, navigateBranch: boolean) => Promise<void>;
  onFork?: (session: SessionInfo, entryId: string) => Promise<void>;
  onOpenFile?: (filePath: string) => void; onFullMap?: () => void;
}
export function LancerWorkbench(props: Props) {
  if (props.enabled === false) return <>{props.children}</>;
  return <ActiveLancerWorkbench {...props} />;
}
function ActiveLancerWorkbench(props: Props) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<TaskScope>("family");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { try { setOpen(sessionStorage.getItem("pi-web:lancer-tree-open") === "1"); } catch {} }, []);
  const setTreeOpen = (value: boolean) => { setOpen(value); try { sessionStorage.setItem("pi-web:lancer-tree-open", value ? "1" : "0"); } catch {} };
  const id = props.session && !props.session.transient ? props.session.id : "";
  const { data, loading, error, refresh } = useTaskGraph(id, scope, open && Boolean(id), props.eventVersion ?? 0);
  useTaskLights(root, data, open && Boolean(id), id, scope);
  return <div ref={root} className="lancer-workbench" style={{ "--lancer-current-lane-color": taskLaneColor(id) } as CSSProperties}>
    {(props.session || props.newSessionCwd) && <ModuleWorkflowBar key={id || props.newSessionDraftKey} sessionId={id || null} draftWorkflow={props.draftWorkflow} onDraftWorkflowChange={props.onDraftWorkflowChange} cwd={props.session?.cwd ?? props.newSessionCwd!} busy={props.busy} models={props.models} currentModel={props.currentModel} onModelChange={props.onModelChange} composerRef={props.composerRef} treeOpen={open} onToggleTree={() => setTreeOpen(!open)} />}
    <div className="lancer-workbench-body"><div className="lancer-conversation">{props.children}</div>
      {open && id && <TaskTreePanel key={id} graph={data} loading={loading} error={error} scope={scope} onScope={setScope} onRefresh={refresh} onClose={() => setTreeOpen(false)} onNavigate={props.onNavigate} onFork={props.onFork} onOpenFile={props.onOpenFile} onFullMap={props.onFullMap} />}
    </div>
  </div>;
}
