// Upstream 0.15.0 and Lancer together: a streaming model switch keeps the
// transcript in place, and a side chat uses the native panel composer.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
const base=process.env.LANCER_TEST_BASE??'http://127.0.0.1:30144';
const out=resolve(process.env.LANCER_TEST_ARTIFACTS??'artifacts/upgrade-side-chat');mkdirSync(out,{recursive:true});
const stamp='2026-11-09T00:00:00.000Z';
const main={id:'upgrade-main-fixture',name:'Upgrade main',path:'upgrade-main.jsonl',cwd:'D:/coding/pi-web-c',projectRoot:'D:/coding/pi-web-c',projectKey:'d:/coding/pi-web-c',created:stamp,modified:stamp,messageCount:2,firstMessage:'Upgrade fixture question'};
const side={...main,id:'upgrade-side-fixture',name:'Side chat',path:'upgrade-side.jsonl',relation:{kind:'side',parentSessionId:main.id,createdAt:stamp}};
let sideCreated=false,model={provider:'fixture',modelId:'first'},promptRequests=0,sideCreates=0;
const setModelRequests=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},serviceWorkers:'block'});
await context.addInitScript(()=>localStorage.setItem('pi-locale','en'));
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
const graph=(scope)=>({sessionId:main.id,running:[main.id],edges:[],truncated:false,lanes:(scope==='current'?[main]:sideCreated?[main,side]:[main]).map(session=>({session,model:'fixture/'+(session.id===main.id?model.modelId:'first'),truncated:false,nodes:[{id:session.id+':u',sessionId:session.id,entryId:'u',parentId:null,kind:'user',text:'Upgrade fixture question',timestamp:stamp},{id:session.id+':a',sessionId:session.id,entryId:'a',parentId:session.id+':u',kind:'answer',text:'Upgrade fixture answer',timestamp:stamp}]}))});
await context.route('**/api/**',async route=>{
 const request=route.request(),url=new URL(request.url()),path=url.pathname,method=request.method();
 const json=(body,status=200)=>route.fulfill({json:body,status});
 if(path==='/api/sessions')return json({sessions:sideCreated?[main,side]:[main],runningSessionIds:[main.id],sessionListVersion:sideCreated?1:0});
 if(path==='/api/sessions/ui-state')return json({version:1,revision:0,sessions:{},projects:{}});
 if(path==='/api/sessions/stats')return json({stats:{}});
 if(path===`/api/sessions/${main.id}/fork`&&method==='POST'){
  assert.deepEqual(request.postDataJSON(),{side:true});sideCreates++;sideCreated=true;return json({sessionId:side.id,session:side});
 }
 const session=path===`/api/sessions/${main.id}`?main:path===`/api/sessions/${side.id}`?side:null;
 if(session)return json({sessionId:session.id,filePath:session.path,info:session,leafId:'a',tree:[],snapshotRevision:'upgrade-fixture',context:{messages:[{role:'user',content:'Upgrade fixture question',timestamp:Date.parse(stamp)},{role:'assistant',content:[{type:'text',text:'Upgrade fixture answer'}],provider:'fixture',model:'first',timestamp:Date.parse(stamp)}],entryIds:['u','a'],oldestEntryId:'u',hasMore:false,turnsBefore:0,thinkingLevel:'medium',model:session.id===main.id?model:{provider:'fixture',modelId:'first'}},stats:{userMessages:1,assistantMessages:1,toolCalls:0,toolResults:0,totalMessages:2,tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0}});
 if(path.endsWith('/state'))return json({isStreaming:path.includes(main.id),isPromptRunning:path.includes(main.id),isCompacting:false,model:{provider:model.provider,id:model.modelId}});
 if(path==='/api/agent/running')return json({runningSessionIds:[main.id],awaitingInputSessionIds:[],subagentsActiveSessionIds:[],sessionListVersion:sideCreated?1:0,sessionUiStateRevision:0});
 if(path.startsWith('/api/agent/')){
  const isMain=path.includes(main.id);
  if(path.endsWith('/events'))return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'connected',isStreaming:isMain})+'\n\n'});
  if(method==='POST'){
   const body=request.postDataJSON()??{};
   if(body.type==='prompt')promptRequests++;
   if(body.type==='set_model'){model={provider:body.provider,modelId:body.modelId};setModelRequests.push(body);return json({success:true,data:{provider:model.provider,id:model.modelId}});}
   return json({success:true,data:body.type==='get_tools'?{tools:[]}:body.type==='get_commands'?{commands:[]}:{}});
  }
  return json({state:{isStreaming:isMain,isPromptRunning:isMain,isCompacting:false,model:isMain?{provider:model.provider,id:model.modelId}:{provider:'fixture',id:'first'},thinkingLevel:'medium',extensionStatuses:[],extensionWidgets:[],contextUsage:null}});
 }
 if(path==='/api/models')return json({models:{'fixture:first':'Upgrade First','fixture:second':'Upgrade Second'},modelList:[{provider:'fixture',providerName:'Upgrade Provider',id:'first',name:'Upgrade First'},{provider:'fixture',providerName:'Upgrade Provider',id:'second',name:'Upgrade Second'}],defaultModel:model,defaultThinkingLevel:'medium',thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}});
 if(path==='/api/workbench/modules')return json({version:1,revision:0,modules:[],sessions:{},adoptions:{}});
 if(path==='/api/workbench/graph')return json(graph(url.searchParams.get('scope')));
 if(path.includes('/snapshots'))return json({enabled:false,snapshots:[]});
 if(path==='/api/skills')return json({skills:[],diagnostics:[],projectResourcesLoaded:true});
 if(path==='/api/project-trust')return json({trusted:true,requiresTrust:false,servers:[]});
 if(path==='/api/worktrees')return json({isGit:false,worktrees:[],projectRoot:main.cwd});
 if(path==='/api/git/status'||path==='/api/file-index')return json({files:[]});
 if(path.startsWith('/api/files/'))return json({entries:[],path:main.cwd});
 if(path==='/api/app-update')return json({updateAvailable:false,currentVersion:'0.15.0'});
 if(path==='/api/open-in-explorer')return json({available:false});
 return json({});
});
const report={passed:false,fixtureBacked:true,checks:[],errors};
try{
 await page.goto(base+'/?session='+main.id,{waitUntil:'domcontentloaded',timeout:90000});
 await page.locator('.lancer-workbench-toolbar').waitFor({timeout:60000});
 const transcript=page.locator('.lancer-conversation [data-entry-id="a"]').first();await transcript.waitFor();
 const handle=await transcript.elementHandle();
 const trigger=page.locator('.lancer-conversation .model-selector.is-toolbar > button').first();
 await page.waitForFunction(()=>document.querySelector('.lancer-conversation .chat-input-textarea')?.placeholder.toLowerCase().includes('steer'));
 assert.equal(await trigger.isEnabled(),true,'the upstream model control remains enabled during a run');
 await trigger.click();await page.getByText('Upgrade Second',{exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.lancer-conversation .model-selector.is-toolbar > button')?.textContent?.includes('Upgrade Second'));
 assert.equal(setModelRequests.length,1);assert.equal(model.modelId,'second');
 assert.equal(await handle.evaluate(element=>element.isConnected),true,'a streaming model switch must preserve the native transcript DOM');
 report.checks.push('mid-run-model-switch','streaming-transcript-dom-preserved');
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await page.getByRole('button',{name:'New side chat',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('#file-panel .chat-input-textarea').length===1);
 assert.equal(sideCreates,1);assert.equal(await page.locator('.lancer-workbench-toolbar').count(),1,'only the main chat carries a Lancer toolbar');
 assert.equal(await page.locator('#file-panel .lancer-workbench').count(),0,'side chat retains its native upstream layout');
 assert.equal(await page.locator('#file-panel .chat-input-textarea').isVisible(),true);
 await page.getByRole('button',{name:'Agents',exact:true}).click();
 await page.locator('.lancer-workbench-toolbar').getByRole('button',{name:'Task tree',exact:true}).click();
 await page.locator(`[data-workbench-lane-model="${side.id}"]`).waitFor();
 assert.equal(await page.locator('.lancer-lane').count(),2,'family scope contains the side chat');
 report.checks.push('native-side-panel-composer','single-main-lancer-workbench','side-chat-in-family-task-tree');
 await page.reload({waitUntil:'domcontentloaded'});
 await page.locator('#file-panel .chat-input-textarea').waitFor({timeout:30000});
 assert.equal(await page.locator('.lancer-workbench-toolbar').count(),1);
 assert.equal(await page.locator('#file-panel .lancer-workbench').count(),0);
 report.checks.push('side-tab-restored-after-reload');
 assert.equal(promptRequests,0);assert.deepEqual(errors,[]);
 report.promptRequests=promptRequests;report.modelSwitchRequests=setModelRequests.length;report.sideCreates=sideCreates;report.passed=true;
 await page.screenshot({path:resolve(out,'upgrade-side-chat.png')});
 writeFileSync(resolve(out,'UPGRADE_SIDE_CHAT_RESULT.json'),JSON.stringify(report,null,2));
 console.log('PASS: upstream mid-run model switch, restored side tabs, native side composer and Lancer family tree; zero prompts');
}catch(error){report.error=String(error);report.promptRequests=promptRequests;writeFileSync(resolve(out,'UPGRADE_SIDE_CHAT_FAILURE.json'),JSON.stringify(report,null,2));await page.screenshot({path:resolve(out,'upgrade-side-chat-failure.png')});throw error;}
finally{await browser.close();}
