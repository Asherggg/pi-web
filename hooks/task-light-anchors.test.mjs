import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const { taskLaneColor, collectNewLightNodes, revealTaskTarget, visibleTaskAnchor }=await jiti.import('./task-light-anchors.ts');
const rect=(left=0,top=0,width=20,height=20)=>({left,top,right:left+width,bottom:top+height,width,height});
function graph(nodes){return {sessionId:'parent',lanes:[{session:{id:'parent'},nodes}],running:[],edges:[],truncated:false};}
test('session colors stay stable independently of focus and lane ordering',()=>{
 const palette=['#3B82F6','#8B5CF6','#10B981','#DB2777','#F59E0B'];
 const sessions=['parent','child','grandchild','independent'];
 const colors=new Map(sessions.map(id=>[id,taskLaneColor(id)]));
 for(const id of sessions.toReversed()){
  assert.ok(palette.includes(taskLaneColor(id)));
  assert.equal(taskLaneColor(id),colors.get(id));
 }
 assert.equal(taskLaneColor('child'),colors.get('child'));
});
test('known history stays silent and only semantic result events emit',()=>{
 const old={id:'parent:old',kind:'answer'};const seen=new Set([old.id]);
 const nodes=[old,...['user','tools','answer','file','report','result','model'].map(kind=>({id:'parent:'+kind,kind}))];
 assert.deepEqual(collectNewLightNodes(graph(nodes),seen).map(n=>n.kind),['answer','file','report','result','model']);
 assert.deepEqual(collectNewLightNodes(graph(nodes),seen),[]);
 assert.equal(seen.size,8);
});
test('file and result identities remain independent without changing transcript data',()=>{
 const nodes=Object.freeze([Object.freeze({id:'parent:r',entryId:'r',kind:'answer'}),Object.freeze({id:'parent:r:file',entryId:'r',kind:'file'})]);
 const before=JSON.stringify(nodes);const result=collectNewLightNodes(graph(nodes),new Set());
 assert.equal(result.length,2);assert.equal(JSON.stringify(nodes),before);
});
test('following a target scrolls only the work tree, not the chat or page',()=>{
 const tree={scrollTop:30,scrollLeft:10,getBoundingClientRect:()=>rect(0,0,200,200)};
 const target={closest:selector=>selector==='.lancer-tree-scroll'?tree:null,getBoundingClientRect:()=>rect(350,400,10,10),scrollIntoView:()=>assert.fail('must not scroll ancestors')};
 revealTaskTarget(target);assert.equal(tree.scrollTop,250);assert.equal(tree.scrollLeft,180);
});
test('hidden and clipped bubbles are not substituted with nearby anchors',t=>{
 const old=globalThis.getComputedStyle;globalThis.getComputedStyle=element=>({visibility:element.hidden?'hidden':'visible'});t.after(()=>{globalThis.getComputedStyle=old;});
 const pane={getBoundingClientRect:()=>rect(0,20,300,200)};
 const node=(bounds,hidden=false)=>({hidden,getClientRects:()=>[bounds],getBoundingClientRect:()=>bounds,closest:()=>pane});
 const hidden=node(rect(10,30),true),clipped=node(rect(10,10)),visible=node(rect(10,40));
 const root={getBoundingClientRect:()=>rect(0,0,600,400),querySelectorAll:selector=>selector==='exact-native-entry'?[hidden,clipped,visible]:[clipped]};
 assert.equal(visibleTaskAnchor(root,'exact-native-entry'),visible);
 assert.equal(visibleTaskAnchor(root,'missing-native-entry'),null);
});
