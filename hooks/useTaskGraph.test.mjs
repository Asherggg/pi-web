import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createJiti} from 'jiti';
const shim=fileURLToPath(new URL('./__fixtures__/react-hook-shim.mjs',import.meta.url));
const jiti=createJiti(import.meta.url,{alias:{react:shim}});
const {renderHook}=await import(pathToFileURL(shim).href);
const {useTaskGraph}=await jiti.import('./useTaskGraph.ts');
const requests=[],mounted=[],intervals=new Set();
const old={fetch:globalThis.fetch,document:globalThis.document,setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval};
globalThis.document=new EventTarget();document.hidden=false;
globalThis.setInterval=fn=>{intervals.add(fn);return fn;};globalThis.clearInterval=fn=>intervals.delete(fn);
globalThis.fetch=(url,init)=>new Promise(resolve=>requests.push({url,signal:init.signal,done:false,resolve(body,status=200){this.done=true;resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}}));}}));
const graph=(id='a',entry='old',error)=>({sessionId:id,running:[],edges:[],truncated:false,lanes:[{session:{id},truncated:false,error,nodes:error?[]:[{id:id+':'+entry,entryId:entry,kind:'answer',text:entry}]}]});
const props=(version=0,enabled=true,id='a',scope='family')=>({version,enabled,id,scope});
const render=(input=props())=>{const h=renderHook(p=>useTaskGraph(p.id,p.scope,p.enabled,p.version),input);mounted.push(h);return h;};
async function settle(h){for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));h?.flush();}
test.afterEach(async()=>{for(const h of mounted.splice(0))h.unmount();for(const r of requests)if(!r.done)r.resolve(graph());await settle();requests.length=0;document.hidden=false;assert.equal(intervals.size,0);});
test.after(()=>Object.assign(globalThis,old));
test('ordinary refresh keeps the graph and coalesces arrivals without cancelling in-flight work',async()=>{
 const h=render();requests[0].resolve(graph());await settle(h);const previous=h.result.data;
 h.rerender(props(1));assert.equal(h.result.data,previous);assert.equal(requests.length,2);
 h.rerender(props(2));h.rerender(props(3));assert.equal(requests.length,2);assert.equal(requests[1].signal.aborted,false);
 requests[1].resolve(graph('a','middle'));await settle(h);assert.equal(requests.length,3);assert.equal(h.result.data.lanes[0].nodes[0].entryId,'middle');
 requests[2].resolve(graph('a','latest'));await settle(h);assert.equal(h.result.data.lanes[0].nodes[0].entryId,'latest');
});
test('reopening exposes no retained graph before the fresh opening snapshot',async()=>{
 const h=render();requests[0].resolve(graph());await settle(h);assert.ok(h.result.data);
 h.rerender(props(0,false));assert.equal(h.result.data,null);
 h.rerender(props(0,true));assert.equal(h.result.data,null);assert.equal(h.result.loading,true);
 requests[1].resolve(graph('a','recorded-while-closed'));await settle(h);assert.equal(h.result.data.lanes[0].nodes[0].entryId,'recorded-while-closed');
});
test('late replies from another session or scope cannot overwrite the active generation',async()=>{
 const h=render();h.rerender(props(0,true,'b','project'));assert.equal(requests[0].signal.aborted,true);
 requests[0].resolve(graph('a','stale'));await settle(h);assert.equal(h.result.data,null);
 requests[1].resolve(graph('b','current'));await settle(h);assert.equal(h.result.data.sessionId,'b');
});
test('failed refreshes and failed lanes keep their last good data',async()=>{
 const h=render();requests[0].resolve(graph());await settle(h);const previous=h.result.data;
 h.result.refresh();h.flush();requests[1].resolve({error:'unavailable'},503);await settle(h);assert.equal(h.result.data,previous);assert.equal(h.result.error,'historyError');
 h.result.refresh();h.flush();requests[2].resolve(graph('a','unused','lane-failed'));await settle(h);
 assert.equal(h.result.data.lanes[0].nodes[0].entryId,'old');assert.equal(h.result.data.lanes[0].error,'lane-failed');
});
