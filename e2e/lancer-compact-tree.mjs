import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createJiti} from 'jiti';
import {chromium} from 'playwright';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {buildTaskLane}=await jiti.import('../lib/workbench/graph.ts');
const base=process.env.LANCER_TEST_BASE??'http://127.0.0.1:30144';
const out=resolve(process.env.LANCER_TEST_ARTIFACTS??'artifacts/lancer-compact-tree/browser');mkdirSync(out,{recursive:true});
const sid='remote-motion-parent',stamp='2026-11-09T00:00:00Z';
const session={id:sid,name:'长会话：代码修改与验证',cwd:'D:/coding/pi-web-c',created:stamp,modified:stamp};
const entries=[];let parent=null;
const add=(id,message)=>{entries.push({type:'message',id,parentId:parent,timestamp:stamp,message});parent=id;};
for(let round=0;round<24;round++){
 add('u'+round,{role:'user',content:'第 '+round+' 轮：检查并修改任务树组件，保留历史与模型光效的准确定位。'});
 for(const [index,name] of ['read','edit','bash','grep'].entries()){
  const args=name==='bash'?{command:'node --version'}:name==='grep'?{pattern:'TaskTreePanel'}:{path:'D:/coding/pi-web-c/components/TaskTreePanel.tsx',...(name==='edit'?{edits:[{oldText:'before',newText:'after'}]}:{})};
  add('c'+round+'-'+index,{role:'assistant',content:[{type:'toolCall',id:'tool'+round+'-'+index,name,arguments:args}]});
  add('r'+round+'-'+index,{role:'toolResult',toolCallId:'tool'+round+'-'+index,toolName:name,isError:false,content:[{type:'text',text:'import SECRET_SOURCE from "node:assert/strict";\n'.repeat(200)}]});
 }
 add('a'+round,{role:'assistant',stopReason:'stop',content:[{type:'text',text:'第 '+round+' 轮已完成，详细结果保存在原始对话。'}]});
}
let lane=buildTaskLane(session,entries);lane.nodes.forEach(node=>{node.active=true;});
let graph={sessionId:sid,running:[],edges:[],truncated:false,lanes:[lane]};
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
await context.addInitScript(()=>localStorage.setItem('pi-locale','zh-CN'));
let requests=0;const errors=[];
await context.route('**/api/**',route=>{
 const path=new URL(route.request().url()).pathname;
 if(path==='/api/workbench/graph')return route.fulfill({json:graph});
 if(path.startsWith('/api/agent/')&&route.request().method()==='POST')requests++;
 return route.fulfill({json:{enabled:false,snapshots:[]}});
});
const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
const report={passed:false,rawNodes:lane.nodes.length,checks:[],errors};
const turn=(n)=>page.locator('[data-task-turn="turn:'+sid+':u'+n+'"]');
try{
 await page.goto(base+'/graph-motion',{waitUntil:'domcontentloaded',timeout:90000});
 await page.locator('[data-task-turn]').first().waitFor();await page.locator('[data-light-layer]').waitFor({state:'attached'});
 assert.equal(await page.locator('[data-task-turn]').count(),10,'only the ten most recent loaded rounds start mounted');
 assert.equal(await page.locator('[data-task-turn-toggle][aria-expanded="true"]').count(),1);
 assert.equal(await page.locator('[data-task-row-kind="tools"]').count(),0,'historical process starts folded');
 assert.ok((await page.locator('[data-task-counts]').innerText()).includes('24 轮 · 96 次工具操作'));
 report.defaultRows=await page.locator('[data-task-node]').count();assert.ok(report.defaultRows<25);
 await page.screenshot({path:resolve(out,'compact-tree-default.png')});
 assert.equal(await page.locator('.lancer-node-active').count(),0,'branch membership must not paint every row as executing');
 assert.ok(!(await page.locator('.lancer-tree').innerText()).includes('SECRET_SOURCE'));
 report.checks.push('ten-recent-rounds','history-default-folds','tool-operation-counts-without-double-counting','no-source-body-in-summaries','no-false-running-highlights');
 await turn(15).locator('[data-task-turn-toggle]').click();
 await turn(15).locator('[data-task-process-toggle]').click();
 assert.equal(await turn(15).locator('[data-task-row-kind="tools"]').count(),4,'a call and its result render as one operation');
 const read=turn(15).getByRole('button',{name:/读取: TaskTreePanel\.tsx/});
 await read.click();assert.equal(await page.locator('[data-fixture-selected]').innerText(),sid+':r15-0');
 const oldRow=await read.elementHandle();
 await page.getByRole('button',{name:'Refresh graph',exact:true}).evaluate(el=>el.click());
 await page.waitForTimeout(200);
 assert.equal(await oldRow.evaluate(node=>node.isConnected),true,'polls retain expanded native rows');
 assert.equal(await turn(15).locator('[data-task-process-toggle]').getAttribute('aria-expanded'),'true');
 report.checks.push('call-result-one-row','native-result-navigation','refresh-retains-expanded-process');
 await turn(15).locator('[data-task-turn-toggle]').click();
 await page.waitForFunction(()=>{
  const svg=document.querySelector('.lancer-lineage-overlay'),lanes=document.querySelector('.lancer-lanes');
  return !svg||svg.getBoundingClientRect().height<=lanes.clientHeight+1;
 });
 report.checks.push('svg-shrinks-with-collapsed-history');
 await page.locator('[data-task-earlier]').click();assert.equal(await page.locator('[data-task-turn]').count(),20);
 await page.locator('[data-task-earlier]').click();assert.equal(await page.locator('[data-task-turn]').count(),24);
 report.checks.push('earlier-rounds-expand-without-history-replay');
 assert.equal(await page.locator('[data-curve-route]').count(),0);
 // Fold the current round. A newly arrived answer must target the explicit
 // owning round, without opening its process or replacing the chat scroll.
 await turn(23).locator('[data-task-turn-toggle]').click();
 await page.locator('.lancer-tree-scroll').evaluate(el=>{el.scrollTop=el.scrollHeight;el.dispatchEvent(new Event('scroll'));});
 await page.getByRole('button',{name:'Attach canonical ID',exact:true}).click();
 const chatTop=await page.locator('[data-workbench-chat-scroll]').evaluate(el=>el.scrollTop);
 add('late-entry',{role:'assistant',stopReason:'stop',content:[{type:'text',text:'折叠轮次中的新增结果'}]});
 lane=buildTaskLane(session,entries);lane.nodes.forEach(node=>{node.active=true;});graph={...graph,lanes:[lane]};
 await page.getByRole('button',{name:'Refresh graph',exact:true}).click();
 const curve=page.locator('[data-curve-id="'+sid+':late-entry:model"]');await curve.waitFor({state:'attached',timeout:10000});
 const endpoint=await page.evaluate((sid)=>{
  const mapping=document.querySelector('[data-task-anchor-for="'+sid+':late-entry"]');
  const target=document.querySelector('[data-task-light-target="'+mapping.dataset.taskAnchorId+'"]');
  const box=target.getBoundingClientRect(),layer=document.querySelector('[data-light-layer]').getBoundingClientRect();
  const values=document.querySelector('[data-curve-id="'+sid+':late-entry:model"]').getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
  return {owner:mapping.dataset.taskAnchorId,actual:values.slice(-2),expected:[box.left+box.width/2-layer.left,box.top+box.height/2-layer.top]};
 },sid);
 assert.equal(endpoint.owner,'turn:'+sid+':u23');
 endpoint.actual.forEach((n,i)=>assert.ok(Math.abs(n-endpoint.expected[i])<1.01));
 assert.equal(await turn(23).locator('[data-task-turn-toggle]').getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('[data-workbench-chat-scroll]').evaluate(el=>el.scrollTop),chatTop);
 report.foldedFlight=endpoint;report.checks.push('folded-flight-explicit-owner','flight-does-not-open-folds-or-scroll-chat');
 await curve.waitFor({state:'detached'});
 await page.locator('.lancer-tree-scroll').evaluate(el=>{el.scrollTop=0;el.dispatchEvent(new Event('scroll'));});
 await page.locator('[data-task-jump-latest]').waitFor();
 const reading=await page.locator('.lancer-tree-scroll').evaluate(el=>el.scrollTop);
 add('next-entry',{role:'assistant',stopReason:'stop',content:[{type:'text',text:'不要打断阅读'}]});
 graph={...graph,lanes:[buildTaskLane(session,entries)]};
 await page.getByRole('button',{name:'Refresh graph',exact:true}).click();await page.waitForTimeout(250);
 assert.equal(await page.locator('.lancer-tree-scroll').evaluate(el=>el.scrollTop),reading,'new arrivals must not pull the reader away');
 await page.locator('[data-task-jump-latest]').click();
 report.checks.push('tree-reading-position-preserved','explicit-return-to-latest');
 const extraFiles=Array.from({length:9},(_,i)=>({id:sid+':extra-file-'+i,sessionId:sid,entryId:'extra-file-'+i,parentId:sid+':next-entry',turnId:sid+':u23',kind:'file',text:'D:/deliverables/report-'+i+'.txt',filePath:'D:/deliverables/report-'+i+'.txt',timestamp:stamp}));
 graph={...graph,lanes:[{...graph.lanes[0],nodes:[...graph.lanes[0].nodes,...extraFiles]}]};
 await page.getByRole('button',{name:'Refresh graph',exact:true}).click();
 await page.locator('[data-task-anchor-for="'+sid+':extra-file-8"]').waitFor({state:'attached'});
 await turn(23).locator('[data-task-turn-toggle]').click();
 assert.equal(await turn(23).locator('[data-task-row-kind="file"]').count(),3,'a round previews three distinct files');
 await turn(23).locator('[data-task-files-toggle]').click();
 assert.equal(await turn(23).locator('[data-task-row-kind="file"]').count(),10);
 await turn(23).locator('[data-task-files-toggle]').click();
 assert.equal(await page.locator('.lancer-deliverables button:not([data-task-delivery-toggle])').count(),5,'the bottom delivery list also has a compact preview');
 await page.locator('[data-task-delivery-toggle]').click();
 assert.equal(await page.locator('.lancer-deliverables button:not([data-task-delivery-toggle])').count(),10);
 await page.locator('[data-task-delivery-toggle]').click();
 report.checks.push('bounded-round-file-preview','bounded-delivery-preview','all-delivery-files-remain-expandable');
 await page.screenshot({path:resolve(out,'compact-tree-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 await turn(23).locator('[data-task-process-toggle]').click();
 const mobile=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,rows:[...document.querySelectorAll('.lancer-tree-node > button:first-of-type')].map(el=>el.getBoundingClientRect().height),texts:[...document.querySelectorAll('.lancer-node-text')].map(el=>getComputedStyle(el).whiteSpace)}));
 assert.equal(mobile.overflow,false);assert.ok(mobile.rows.length&&mobile.rows.every(height=>height>=44));
 assert.ok(mobile.texts.every(value=>value==='nowrap'));
 report.mobile=mobile;await page.screenshot({path:resolve(out,'compact-tree-mobile.png')});
 report.checks.push('mobile-44px-targets','single-line-summaries','no-page-horizontal-overflow');
 assert.equal(requests,0);assert.deepEqual(errors,[]);report.promptRequests=requests;report.passed=true;
 writeFileSync(resolve(out,'COMPACT_TREE_RESULT.json'),JSON.stringify(report,null,2));
 console.log('PASS: compact rounds, exact tool merges/navigation, folded native light anchors, preserved reading and mobile layout; zero prompts');
}catch(error){report.error=String(error);writeFileSync(resolve(out,'COMPACT_TREE_FAILURE.json'),JSON.stringify(report,null,2));await page.screenshot({path:resolve(out,'compact-tree-failure.png')});throw error;}
finally{await browser.close();}
