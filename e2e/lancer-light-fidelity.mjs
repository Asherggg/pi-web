// Actual components in the explicit UI-only fixture host; no provider/session writes.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const base=process.env.LANCER_TEST_BASE??'http://127.0.0.1:30143';
const out=resolve(process.env.LANCER_TEST_ARTIFACTS??'artifacts/lancer-light-fidelity');mkdirSync(out,{recursive:true});
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
try{
 await page.goto(base+'/motion-fixture',{waitUntil:'domcontentloaded'});
 await page.locator('[data-task-light-target]').first().waitFor();
 await page.locator('[data-light-layer]').waitFor({state:'attached'});
 assert.equal(await page.locator('[data-task-node]').first().locator('button').first().evaluate(el=>getComputedStyle(el).textAlign),'left');
 assert.equal(await page.locator('[data-light-layer]').count(),1);
 assert.equal(await page.locator('[data-curve-route]').count(),0);
 report.checks.push('silent-initial-history');
 await page.evaluate(()=>{
  window.__lightEvents=[];window.__peakLightCount=0;
  new MutationObserver(()=>{
   window.__peakLightCount=Math.max(window.__peakLightCount,document.querySelectorAll('[data-curve-route]').length);
   for(const path of document.querySelectorAll('[data-curve-route]')){
    const id=path.getAttribute('data-curve-id');
    if(!window.__lightEvents.some(event=>event.id===id))window.__lightEvents.push({id,first:performance.now(),d:path.getAttribute('d')});
   }
  }).observe(document.querySelector('[data-light-layer]'),{childList:true,subtree:true});
 });
 await page.getByRole('button',{name:'Emit result',exact:true}).click();
 const model=page.locator('[data-curve-id="motion-parent:arrival-1:model"]');
 const message=page.locator('[data-curve-id="motion-parent:arrival-1:message"]');
 await model.waitFor({state:'attached'});await message.waitFor({state:'attached'});
 const endpoints=await page.evaluate(()=>{
  const layer=document.querySelector('[data-light-layer]').getBoundingClientRect();
  const target=document.querySelector('[data-task-light-target="motion-parent:arrival-1"]').getBoundingClientRect();
  const sources={model:document.querySelector('[data-workbench-model-source]'),message:document.querySelector('[data-entry-id="arrival-1"]')};
  return Object.entries(sources).map(([kind,element])=>{
   const id='motion-parent:arrival-1:'+kind;
   const p=document.querySelector('[data-curve-id="'+id+'"]');const values=p.getAttribute('d').match(/-?\d+(?:\.\d+)?/g).map(Number);
   const source=element.getBoundingClientRect();
   return {kind,from:values.slice(0,2),to:values.slice(-2),expectedFrom:[source.left+source.width/2-layer.left,source.top+source.height/2-layer.top],expectedTo:[target.left+target.width/2-layer.left,target.top+target.height/2-layer.top],headColor:document.querySelector('[data-flight-head="'+id+'"]').getAttribute('fill'),headComputedColor:getComputedStyle(document.querySelector('[data-flight-head="'+id+'"]')).fill,nodeColor:getComputedStyle(document.querySelector('[data-task-light-target="motion-parent:arrival-1"]')).backgroundColor};
  });
 });
 for(const edge of endpoints){for(let i=0;i<2;i++){assert.ok(Math.abs(edge.from[i]-edge.expectedFrom[i])<1);assert.ok(Math.abs(edge.to[i]-edge.expectedTo[i])<1);}assert.equal(edge.headComputedColor,edge.nodeColor);}
 report.endpoints=endpoints;report.checks.push('model-and-message-both-emit','native-node-center-landing','lane-and-flight-colors-match');
 const firstPath=await model.getAttribute('d');
 await page.screenshot({path:resolve(out,'faithful-flight.png')});
 await page.waitForFunction(()=>{
  const first=window.__lightEvents.find(event=>event.id==='motion-parent:arrival-1:model');
  return first&&performance.now()-first.first>=820;
 });
 assert.equal(await model.count(),1,'flight must remain active beyond the former 700ms cutoff');
 assert.equal(await model.getAttribute('d'),firstPath,'a single flight must not jitter its authored path');
 await model.waitFor({state:'detached',timeout:4000});await message.waitFor({state:'detached'});
 await page.waitForFunction(()=>!document.querySelector('[data-flight-landing]'));
 report.checks.push('original-1200ms-flight','stable-flight-path','landing-and-idle-cleanup');
 await page.getByRole('button',{name:'Toggle execution',exact:true}).click();
 await page.locator('[data-workbench-running-target="true"] [data-workbench-running-border]').waitFor({state:'attached'});
 const border=await page.locator('[data-workbench-running-target="true"] rect').evaluate(rect=>({animation:getComputedStyle(rect).animationName,stroke:getComputedStyle(rect.parentElement).stroke}));
 assert.equal(border.animation,'light-execution-border');
 assert.equal(border.stroke,endpoints[0].nodeColor,'executing bubble and its tree lane use the same color');
 await page.screenshot({path:resolve(out,'faithful-running-border.png')});
 await page.getByRole('button',{name:'Toggle execution',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-workbench-running-border]'));
 report.checks.push('executing-bubble-border','completed-bubble-border-removed');
 const scrollBefore=await page.locator('[data-workbench-chat-scroll]').evaluate(el=>el.scrollTop);
 for(let i=0;i<18;i++)await page.getByRole('button',{name:'Emit result',exact:true}).click();
 assert.equal(await page.locator('[data-workbench-chat-scroll]').evaluate(el=>el.scrollTop),scrollBefore,'tree follow must never scroll the chat');
 assert.ok(await page.locator('.lancer-tree-scroll').evaluate(el=>el.scrollTop>0));
 const peak=await page.evaluate(()=>window.__peakLightCount);assert.ok(peak>0&&peak<=32);report.peakVisibleFlights=peak;
 report.checks.push('tree-only-follow','bounded-burst-emissions');
 await page.getByRole('button',{name:'Close task tree',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('[data-light-layer]'));
 await page.getByRole('button',{name:'Toggle tree',exact:true}).click();
 await page.locator('[data-light-layer]').waitFor({state:'attached'});
 assert.equal(await page.locator('[data-curve-route]').count(),0);
 report.checks.push('close-cancels-flights','reopen-does-not-replay');
 const reduced=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block',reducedMotion:'reduce'});
 await reduced.addInitScript(()=>localStorage.setItem('pi-locale','en'));
 await reduced.route('**/api/**',route=>route.fulfill({json:{enabled:false,snapshots:[]}}));
 const reducedPage=await reduced.newPage();await reducedPage.goto(base+'/motion-fixture');
 await reducedPage.locator('[data-task-light-target]').first().waitFor();
 await reducedPage.locator('[data-light-layer]').waitFor({state:'attached'});
 await reducedPage.getByRole('button',{name:'Emit result',exact:true}).click();
 await reducedPage.locator('[data-task-light-target="motion-parent:arrival-1"]').waitFor();
 assert.equal(await reducedPage.locator('[data-curve-route]').count(),0);
 await reducedPage.getByRole('button',{name:'Toggle execution',exact:true}).click();
 assert.equal(await reducedPage.locator('[data-workbench-running-border] rect').evaluate(el=>getComputedStyle(el).animationName),'none');
 await reduced.close();report.checks.push('reduced-motion-retains-results-without-animation');
 if(process.env.LANCER_UPSTREAM_BASE){
  const original=await context.newPage();await original.goto(process.env.LANCER_UPSTREAM_BASE+'/demo/verify.html');
  await original.locator('#result[data-status="passed"]').waitFor({timeout:20000});report.upstreamVerification=await original.locator('#result').innerText();
  await original.goto(process.env.LANCER_UPSTREAM_BASE+'/demo/index.html');await original.getByRole('button',{name:'开始演示 →',exact:true}).click();await original.waitForTimeout(350);await original.screenshot({path:resolve(out,'upstream-reference.png')});await original.close();
 }
 assert.equal(modelRequests,0);assert.deepEqual(errors,[]);report.modelRequests=modelRequests;report.passed=true;
 writeFileSync(resolve(out,'LIGHT_FIDELITY_RESULT.json'),JSON.stringify(report,null,2));
 console.log('PASS: dual-source original-timing light flights, exact landing/color, bubble borders, follow/cleanup/reduced-motion; zero model requests');
}catch(error){report.error=String(error);writeFileSync(resolve(out,'LIGHT_FIDELITY_FAILURE.json'),JSON.stringify(report,null,2));await page.screenshot({path:resolve(out,'fidelity-failure.png')});throw error;}
finally{await browser.close();}
