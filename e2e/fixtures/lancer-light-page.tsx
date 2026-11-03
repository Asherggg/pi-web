"use client";
import {useRef,useState,type CSSProperties} from 'react';
import type {TaskGraph,TaskNode} from '@/lib/workbench/graph';
import type {SessionInfo,AssistantMessage} from '@/lib/types';
import {I18nProvider} from '@/hooks/useI18n';
import {useTaskLights} from '@/hooks/useTaskLights';
import {useTaskGraph} from '@/hooks/useTaskGraph';
import {taskLaneColor} from '@/hooks/task-light-anchors';
import {TaskTreePanel} from '@/components/workbench/TaskTreePanel';
import {MessageView} from '@/components/MessageView';
import {ModelSelector} from '@/components/ModelSelector';
import '@/components/workbench/workbench.css';
const timestamp='2026-11-03T00:00:00Z';
const session={id:'motion-parent',name:'Primary session',cwd:'D:/coding/pi-web-c',created:timestamp,modified:timestamp} as SessionInfo;
const child={...session,id:'motion-child',name:'Child session',relation:{kind:'subagent',parentSessionId:session.id,status:'completed'}} as SessionInfo;
const node=(id:string,entryId:string,kind:TaskNode['kind'],sessionId=session.id):TaskNode=>({id,entryId,sessionId,parentId:null,kind,text:'Verified fixture event '+entryId,timestamp});
const initial:TaskGraph={sessionId:session.id,running:[],truncated:false,edges:[],lanes:[{session,model:'fixture/primary',truncated:false,nodes:[node('motion-parent:initial','initial','answer')]},{session:child,model:'fixture/worker',truncated:false,nodes:[node('motion-child:initial','initial','answer',child.id)]}]};
function Fixture(){
 const root=useRef<HTMLDivElement>(null);
 const [graph,setGraph]=useState(initial),[open,setOpen]=useState(true),[streaming,setStreaming]=useState(false);
 const [messages,setMessages]=useState(['initial']);const serial=useRef(0);
 useTaskLights(root,graph,open,session.id,'family');
 const add=()=>{const entryId='arrival-'+(++serial.current);setMessages(old=>[...old,entryId]);setGraph(old=>({...old,lanes:old.lanes.map((lane,i)=>i?lane:{...lane,nodes:[...lane.nodes,node(session.id+':'+entryId,entryId,'answer')]})}));};
 const message=(id:string)=>({role:'assistant',content:[{type:'text',text:'Fixture response '+id}],provider:'fixture',model:'primary',timestamp:Date.parse(timestamp),stopReason:'stop'}) as AssistantMessage;
 return <div ref={root} className="lancer-workbench" style={{height:'100vh','--lancer-current-lane-color':taskLaneColor(session.id)} as CSSProperties}>
  <header style={{padding:12,display:'flex',gap:12,alignItems:'center'}}><strong>Motion acceptance fixture</strong><span>No model calls; actual Pi Web components</span><button onClick={add}>Emit result</button><button onClick={()=>setStreaming(!streaming)}>Toggle execution</button><button onClick={()=>setOpen(!open)}>Toggle tree</button></header>
  <div className="lancer-workbench-body"><div className="lancer-conversation" style={{display:'flex',flexDirection:'column',padding:20}}>
   <ModelSelector options={[{provider:'fixture',modelId:'primary',name:'Current model'}]} value={{provider:'fixture',modelId:'primary'}} onChange={()=>{}} ariaLabel="Current model" />
   <div data-workbench-chat-scroll style={{overflow:'auto',flex:1,marginTop:20}}>{messages.map((id,i)=><MessageView key={id} entryId={id} message={message(id)} isStreaming={streaming && i===messages.length-1} />)}</div>
  </div>{open&&<TaskTreePanel graph={graph} loading={false} error={null} scope="family" onScope={()=>{}} onRefresh={()=>{}} onClose={()=>setOpen(false)} />}</div>
 </div>;
}
function RemoteFixture(){
 const root=useRef<HTMLDivElement>(null);
 const [open,setOpen]=useState(true),[version,setVersion]=useState(0),[canonical,setCanonical]=useState(false),[clipped,setClipped]=useState(false);
 const {data,loading,error,refresh}=useTaskGraph('remote-motion-parent','family',open,version);
 useTaskLights(root,data,open,'remote-motion-parent','family');
 const message={role:'assistant',content:[{type:'text',text:'Live response awaiting its canonical entry identity'}],provider:'fixture',model:'primary',timestamp:Date.parse(timestamp),stopReason:'stop'} as AssistantMessage;
 return <div ref={root} className="lancer-workbench" style={{height:'100vh','--lancer-current-lane-color':taskLaneColor('remote-motion-parent')} as CSSProperties}>
  <header style={{padding:12,display:'flex',gap:12}}><strong>Remote graph acceptance fixture</strong><button onClick={()=>setVersion(n=>n+1)}>Refresh graph</button><button onClick={()=>setCanonical(true)}>Attach canonical ID</button><button onClick={()=>setClipped(!clipped)}>Toggle clip</button><button onClick={()=>setOpen(!open)}>Toggle tree</button></header>
  <div className="lancer-workbench-body"><div className="lancer-conversation" style={{padding:20,overflow:'auto'}} data-workbench-chat-scroll>
   <ModelSelector options={[{provider:'fixture',modelId:'primary',name:'Current model'}]} value={{provider:'fixture',modelId:'primary'}} onChange={()=>{}} ariaLabel="Current model" />
   <div data-fixture-clip style={{overflow:'hidden',height:clipped?0:160,marginTop:20}}><MessageView message={message} entryId={canonical?'late-entry':undefined} /></div>
  </div>{open&&<TaskTreePanel graph={data} loading={loading} error={error} scope="family" onScope={()=>{}} onRefresh={refresh} onClose={()=>setOpen(false)} />}</div>
 </div>;
}
export function GraphMotionFixture(){return <I18nProvider><RemoteFixture /></I18nProvider>;}
export default function Page(){return <I18nProvider><Fixture /></I18nProvider>;}
