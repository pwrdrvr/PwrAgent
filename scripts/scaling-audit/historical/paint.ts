import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {expect,test} from "./fixtures/electron-test";
import { StateDb } from "../src/main/state/state-db";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import {launchElectronApp} from "./fixtures/electron-app";
import {seedProfileOverlayState} from "./fixtures/overlay-state-seeding";

test("measures a visible lens switch on the large navigation fixture",async()=>{
  test.setTimeout(180000);
  const root=await mkdtemp(path.join(os.tmpdir(),"audit-sidebar-"));
  const fixture=JSON.parse(await readFile(path.join(import.meta.dirname,"fixtures/a11y-directories/replay.fixture.json"),"utf8"));
  const listing=fixture.steps.find(s=>s.method==="thread/list");
  const original=listing.result[0];
  const now=original.updatedAt;
  const rows=Array.from({length:869},(_,i)=>{
    const project=i<475?0:1+i%101;
    return {...original,id:i?"audit-"+i:original.id,title:i?"Audit thread "+i:original.title,updatedAt:now-i,
      projectKey:"/repo/audit-"+project,linkedDirectories:[{id:"d"+project,kind:"local",label:"Project "+project,path:"/repo/audit-"+project}]};
  });
  listing.result=rows;
  const fixturePath=path.join(root,"replay.fixture.json");
  await writeFile(fixturePath,JSON.stringify(fixture));
  const app=await launchElectronApp({fixturePath,preLaunchHook:async home=>{await seedProfileOverlayState(home,{threads:rows.slice(0,105).map((r,i)=>({backend:"codex",threadId:r.id,executionMode:"default",extraLinkedDirectories:[],pinnedRank:String(i+1).padStart(5,"0")}))});
    const db=StateDb.open(stateDbPathForHomeRoot(home),{profileName:"default"});
    try { db.raw.prepare("INSERT OR REPLACE INTO provider_thread_snapshots(backend,schema_version,observed_at,payload) VALUES(?,?,?,?)").run("codex",1,Date.now(),JSON.stringify(rows)); } finally {db.close();}
  }});
  try{
    const updated=app.window.getByRole("tab",{name:"Updated",exact:true});
    const directories=app.window.getByRole("tab",{name:"Directories",exact:true});
    await expect(updated).toBeVisible();
    await updated.click();
    const readCounts=()=>app.window.evaluate(async()=>{
      const api=window.pwragent;
      try{const page=await api.getNavigationQueryPage({protocol:2,consumer:"main-sidebar",inventory:"viewer",query:{kind:"directory-index"}},"audit-population");return page.counts;}
      finally{await api.releaseNavigationQuery("audit-population");}
    });
    await expect.poll(async()=>(await readCounts()).total,{timeout:45000}).toBe(869);
    const inventory=await readCounts();
    expect(inventory.pinned).toBe(105);
    const samples=[];
    await updated.click();
    for(let i=0;i<12;i++)for(const [tab,selector,name] of [[directories,"section.directory-row .directory-row__summary","Directories"],[updated,".sidebar-list--dense .thread-row","Updated"]] as const){
      const ms=await tab.evaluate(async(el,selector)=>{
        const start=performance.now();
        (el as HTMLElement).click();
        return await new Promise<number>((resolve,reject)=>{
          const frame=()=>{
            const row=[...document.querySelectorAll(selector)].find(e=>e.getBoundingClientRect().height>0);
            if(row && el.getAttribute("aria-selected")==="true")return requestAnimationFrame(()=>resolve(performance.now()-start));
            if(performance.now()-start>10000)return reject(new Error("No visible result for "+selector));
            requestAnimationFrame(frame);
          };requestAnimationFrame(frame);
        });
      },selector);
      if(i>=2)samples.push({name,ms});
    }
    await writeFile(process.env.AUDIT_PAINT_OUTPUT!,JSON.stringify({inventory,samples}));
  }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
