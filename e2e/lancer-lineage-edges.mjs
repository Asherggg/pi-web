// Process-layer acceptance: in-lane branch edges, node glyph shapes and the
// per-lane model-source anchors that flights start from. UI fixture only.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const base=process.env.LANCER_TEST_BASE??'http://127.0.0.1:30143';
const out=resolve(process.env.LANCER_TEST_ARTIFACTS??'artifacts/lancer-light-fidelity/lineage-edges');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
await context.addInitScript(()=>localStorage.setItem('pi-locale','en'));
const page=await context.newPage();const errors=[];let modelRequests=0;
page.on('pageerror',error=>errors.push(error.message));
await context.route('**/api/**',route=>{
 const path=new URL(route.request().url()).pathname;
 if(path.startsWith('/api/agent/')&&route.request().method()==='POST')modelRequests++;
 return route.fulfill({json:path.includes('snapshot-reviews')?{paths:[]}:{enabled:false,snapshots:[]}});
});
const report={passed:false,fixtureBacked:true,modelRequests:0,checks:[],errors};
// Every drawn edge must start and end exactly on its two native anchors.
const measure=()=>page.evaluate(()=>{
 const lanes=document.querySelector('.lancer-lanes');const box=lanes.getBoundingClientRect();
 const centre=(nodeId)=>{
  const dot=document.querySelector('[data-task-node="'+nodeId+'"] [data-task-light-target]');
  if(!dot)return null;const rect=dot.getBoundingClientRect();
  return [rect.left+rect.width/2-box.left,rect.top+rect.height/2-box.top];
 };
 return [...document.querySelectorAll('[data-task-tree-edge]')].map((path)=>{
  const values=path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
  const parent=path.getAttribute('data-task-edge-from'),node=path.getAttribute('data-task-edge-to');
  return {id:path.getAttribute('data-task-tree-edge'),kind:path.getAttribute('data-task-edge-kind'),from:values.slice(0,2),to:values.slice(-2),expectedFrom:centre(parent),expectedTo:centre(node),parent,node};
 });
});
try{
 await page.goto(base+'/motion-fixture',{waitUntil:'domcontentloaded'});
 await page.locator('[data-task-node="motion-parent:merged"]').waitFor();
 await page.locator('.lancer-lineage-overlay').waitFor({state:'attached'});
 await page.locator('[data-task-tree-edge]').waitFor({state:'attached'});
 assert.equal(await page.locator('.lancer-lineage-overlay').evaluate(el=>getComputedStyle(el).pointerEvents),'none','the overlay must never take pointer events from the tree');
 assert.equal(await page.locator('[data-task-edge]').count(),0,'no dispatch/return edge exists in this fixture');
 const edges=await measure();
 assert.equal(edges.length,1,'only the non-linear parent link is drawn; the linear rail stays implicit');
 assert.equal(edges[0].kind,'tree');
 assert.equal(edges[0].parent,'motion-parent:initial');
 assert.equal(edges[0].node,'motion-parent:merged');
 for(let index=0;index<2;index++){
  assert.ok(Math.abs(edges[0].from[index]-edges[0].expectedFrom[index])<1.01,'edge must start at the parent dot centre');
  assert.ok(Math.abs(edges[0].to[index]-edges[0].expectedTo[index])<1.01,'edge must end at the child dot centre');
 }
 report.edges=edges;
 report.checks.push('non-linear-parent-edge-on-native-anchors','linear-rail-not-duplicated','overlay-keeps-pointer-events');
 const shapes=await page.evaluate(()=>{
  const read=(kind)=>{const dot=document.querySelector('.lancer-node-dot-'+kind);
   if(!dot)return null;const style=getComputedStyle(dot);const marker=getComputedStyle(dot,'::after');return {width:style.width,height:style.height,borderRadius:style.borderRadius,transform:style.transform,background:style.backgroundColor,marker:marker.content};};
  return {answer:read('answer'),tools:read('tools'),report:read('report')};
 });
 assert.ok(shapes.answer&&shapes.tools&&shapes.report,'every node kind gets its own dot');
 assert.ok(parseFloat(shapes.tools.width)<parseFloat(shapes.answer.width),'tools events use a smaller marker than answers');
 assert.notEqual(shapes.report.borderRadius,shapes.answer.borderRadius,'delivery dots are not plain circles');
 assert.notEqual(shapes.report.marker,'none','delivery dots carry the verified marker');
 report.shapes=shapes;
 report.checks.push('event-glyph-shapes-per-node-kind');
 const anchors=async()=>{
  return page.evaluate(()=>{
   const lanes=[...document.querySelectorAll('.lancer-lane')];
   return {lanes:lanes.length,scope:document.querySelector('.lancer-tree')?.className,anchors:lanes.map((lane)=>{
    const anchor=lane.querySelector('[data-workbench-lane-model]');
    if(!anchor)return null;const glyph=anchor.querySelector('.lancer-model-glyph');const rect=anchor.getBoundingClientRect();
    return {sessionId:anchor.getAttribute('data-workbench-lane-model'),text:anchor.textContent,visible:rect.width>0&&rect.height>0,overflow:getComputedStyle(anchor).overflow,ellipsis:getComputedStyle(anchor).textOverflow,glyph:glyph?{width:glyph.getBoundingClientRect().width,height:glyph.getBoundingClientRect().height,border:getComputedStyle(glyph).borderStyle}:null};
   })};
  });
 };
 const family=await anchors();
 assert.equal(family.lanes,2,'family scope lists the session and its subagent');
 assert.deepEqual(family.anchors.map(anchor=>anchor.sessionId),['motion-parent','motion-child']);
 assert.deepEqual(family.anchors.map(anchor=>anchor.text),['fixture/primary','fixture/worker']);
 for(const anchor of family.anchors){
  assert.equal(anchor.visible,true,anchor.sessionId+' model source must be measurable');
  assert.equal(anchor.overflow,'hidden');
  assert.equal(anchor.ellipsis,'ellipsis');
  assert.ok(anchor.glyph&&anchor.glyph.width>0&&anchor.glyph.height>0,'the source chip carries a glyph');
 }
 await page.locator('.lancer-tree-controls select').selectOption('project');
 await page.waitForFunction(()=>document.querySelectorAll('.lancer-lane').length===3);
 const project=await anchors();
 assert.equal(project.lanes,3,'project scope lists every lane');
 assert.deepEqual(project.anchors.map(anchor=>anchor.sessionId),['motion-parent','motion-child','motion-project']);
 assert.deepEqual(project.anchors.map(anchor=>anchor.text),['fixture/primary','fixture/worker','fixture/peer']);
 assert.ok(project.anchors.every(anchor=>anchor.visible),'all three source chips stay visible in project scope');
 report.anchors={family,project};
 report.checks.push('lane-model-source-anchors-per-lane');
 const scrolled=await page.locator('.lancer-tree-scroll').evaluate(el=>{el.scrollLeft=el.scrollWidth;return {left:el.scrollLeft,width:el.scrollWidth,client:el.clientWidth};});
 assert.ok(scrolled.width>scrolled.client,'project scope scrolls horizontally instead of squeezing lanes');
 await page.waitForTimeout(120);
 const shifted=await measure();
 assert.equal(shifted.length,1);
 for(let index=0;index<2;index++){
  assert.ok(Math.abs(shifted[0].from[index]-shifted[0].expectedFrom[index])<1.01,'edge follows the parent dot after horizontal scroll');
  assert.ok(Math.abs(shifted[0].to[index]-shifted[0].expectedTo[index])<1.01,'edge follows the child dot after horizontal scroll');
 }
 report.scrolled=scrolled;
 report.checks.push('edges-track-horizontal-scroll');
 await page.screenshot({path:resolve(out,'lineage-edges-desktop.png')});
 await page.locator('.lancer-tree-scroll').evaluate(el=>{el.scrollLeft=0;});
 await page.locator('[data-workbench-lane-model="motion-parent"]').waitFor({state:'visible'});
 await page.getByRole('button',{name:'Emit child result',exact:true}).click();
 const model=page.locator('[data-curve-id="motion-child:child-arrival-1:model"]');
 await model.waitFor({state:'attached',timeout:8000});
 const sourceOf=(curveId,anchorSelector)=>page.evaluate(([curveId,anchorSelector])=>{
  const path=document.querySelector('[data-curve-id="'+curveId+'"]');const values=path.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
  const layer=document.querySelector('[data-light-layer]').getBoundingClientRect();const anchor=document.querySelector(anchorSelector).getBoundingClientRect();
  return {curveId,from:values.slice(0,2),expected:[anchor.left+anchor.width/2-layer.left,anchor.top+anchor.height/2-layer.top]};
 },[curveId,anchorSelector]);
 const laneSource=await sourceOf('motion-child:child-arrival-1:model','[data-workbench-lane-model="motion-child"]');
 for(let index=0;index<2;index++) assert.ok(Math.abs(laneSource.from[index]-laneSource.expected[index])<1.01,"another lane's flight leaves from its own model-source anchor");
 await page.getByRole('button',{name:'Emit result',exact:true}).click();
 await page.locator('[data-curve-id="motion-parent:arrival-1:model"]').waitFor({state:'attached',timeout:8000});
 const chatSource=await sourceOf('motion-parent:arrival-1:model','.lancer-conversation [data-workbench-model-source]');
 for(let index=0;index<2;index++) assert.ok(Math.abs(chatSource.from[index]-chatSource.expected[index])<1.01,"the current session's flight leaves from the chat model control");
 report.flightSource={laneSource,chatSource};
 report.checks.push('flight-starts-at-lane-model-source','flight-starts-at-chat-model-source');
 assert.equal(await page.locator('[data-task-tree-edge]').count(),1,'a new event keeps the pre-existing tree edge');
 assert.equal(modelRequests,0);assert.deepEqual(errors,[]);report.modelRequests=modelRequests;report.passed=true;
 writeFileSync(resolve(out,'LINEAGE_EDGES_RESULT.json'),JSON.stringify(report,null,2));
 console.log('PASS: branch edges, per-kind glyphs and per-lane model sources stay anchored, even after horizontal scroll');
}catch(error){report.error=String(error);writeFileSync(resolve(out,'LINEAGE_EDGES_FAILURE.json'),JSON.stringify(report,null,2));await page.screenshot({path:resolve(out,'lineage-edges-failure.png')});throw error;}
finally{await browser.close();}
