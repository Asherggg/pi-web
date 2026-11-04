// UI-only Next host for actual Pi Web components. API/provider requests belong to fixtures.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const host=resolve(process.env.LANCER_PREVIEW_DIR??join(root,'artifacts/lancer-light-fidelity/preview'));
const port=Number(process.env.LANCER_PREVIEW_PORT??30143);
if(!Number.isSafeInteger(port)||port<1024||port>65535||port===30141)throw new Error('Choose an isolated preview port, not the production port.');
for(const folder of ['app','app/motion-fixture','app/graph-motion'])mkdirSync(join(host,folder),{recursive:true});
const save=(name,content)=>writeFileSync(join(host,name),content);
save('package.json',JSON.stringify({name:'pi-web-light-visual-fixture',private:true,type:'module'},null,2));
save('app/page.tsx',`export {default} from '@/app/page';`);
save('app/motion-fixture/page.tsx',`export {default} from '@/e2e/fixtures/lancer-light-page';`);
save('app/graph-motion/page.tsx',`export {GraphMotionFixture as default} from '@/e2e/fixtures/lancer-light-page';`);
save('app/layout.tsx',`import type {ReactNode} from 'react';
import {THEME_INIT_SCRIPT} from '@/lib/theme';
import 'katex/dist/katex.min.css';
import '@/app/globals.css';
import '@/app/settings.css';
import '@/app/sidebar.css';
import '@/app/sidebar-menu.css';
export default function Layout({children}:{children:ReactNode}){return <html lang="en" suppressHydrationWarning><body><script dangerouslySetInnerHTML={{__html:THEME_INIT_SCRIPT}} />{children}</body></html>;}`);
save('tsconfig.json',JSON.stringify({compilerOptions:{target:'ES2020',lib:['dom','dom.iterable','esnext'],skipLibCheck:true,strict:true,noEmit:true,esModuleInterop:true,module:'esnext',moduleResolution:'bundler',jsx:'react-jsx',resolveJsonModule:true,isolatedModules:true,plugins:[{name:'next'}],baseUrl:'.',paths:{'@/*':[join(relative(host,root).replaceAll(String.fromCharCode(92),'/'),'/*')]}},include:['**/*.ts','**/*.tsx','.next/types/**/*.ts','.next/dev/types/**/*.ts'],exclude:['node_modules']},null,2));
save('postcss.config.mjs',`export default {plugins:{'@tailwindcss/postcss':{}}};`);
const config={devIndicators:false,outputFileTracingRoot:root,images:{unoptimized:true},turbopack:{root,rules:{'**/mdast-util-gfm-autolink-literal/lib/index.js':{loaders:[join(root,'lib/gfm-autolink-email-loader.cjs')]}}},transpilePackages:['mermaid','@mermaid-js/parser'],serverExternalPackages:['node-pty','undici','web-push','@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-ai','@earendil-works/pi-tui'],env:{NEXT_PUBLIC_APP_VERSION:'0.13.0',NEXT_PUBLIC_PI_VERSION:'1.4.0'}};
save('next.config.mjs','export default '+JSON.stringify(config,null,2)+';');
const url='http://127.0.0.1:'+port;
let exists=false;
try { const response=await fetch(url+'/motion-fixture',{signal:AbortSignal.timeout(10000)});exists=response.ok&&(await response.text()).includes('Motion acceptance fixture'); } catch {}
if(exists){console.log('Reuse existing light fixture: '+url);process.exit(0);}
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['__NEXT','NEXT_PRIVATE','TURBOPACK','PI_SESSION_'].some(prefix=>key.startsWith(prefix))));
env.NODE_ENV='development';env.NEXT_TELEMETRY_DISABLED='1';
const child=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'dev','-H','127.0.0.1','-p',String(port)],{cwd:host,env,stdio:'inherit',windowsHide:true});
console.log('Light UI fixture (no provider calls): '+url+'/motion-fixture');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>child.kill(signal));
child.once('error',error=>{console.error(error);process.exitCode=1;});
child.once('close',code=>{process.exitCode=code??1;});
