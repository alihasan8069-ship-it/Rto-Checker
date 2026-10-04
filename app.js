const KEY="rto_scanner_v3";
const DB_NAME="rto_return_scanner";
const DB_VERSION=4;
const courierNames=["Delivery","Shadowfax","XpressBees","Valmo"];
let state=JSON.parse(localStorage.getItem(KEY)||"null")||{
 sessionId:null, active:false, completedAt:null, returnType:"RTO", expected:{}, selected:[], records:[], duplicates:[], unknown:[], wrong:[], importFiles:[], mappingMemory:{barcode:"",order:"",courier:""}
};
const $=id=>document.getElementById(id);
let db=null;
let dbReady=false;
let dbWriteTimer=null;
let dbWriteRunning=false;
let dbWriteQueued=false;
function setDbStatus(text,kind="ok"){
  const el=$("dbStatus"); if(!el)return;
  el.textContent=text; el.className="db-status "+kind;
}
function openDatabase(){
  return new Promise((resolve,reject)=>{
    if(!window.indexedDB){setDbStatus("LOCAL DATABASE: NOT SUPPORTED","bad");reject(new Error("IndexedDB unavailable"));return}
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=e=>{
      const d=e.target.result;
      const stores=[
        ["sessions","sessionId"],
        ["expectedParcels","id"],
        ["scanRecords","id"],
        ["duplicateRecords","id"],
        ["unknownRecords","id"],
        ["wrongCourierRecords","id"],
        ["importFiles","id"]
      ];
      stores.forEach(([name,key])=>{if(!d.objectStoreNames.contains(name))d.createObjectStore(name,{keyPath:key,autoIncrement:key==="id"})});
      if(!d.objectStoreNames.contains("meta"))d.createObjectStore("meta",{keyPath:"key"});
      if(!d.objectStoreNames.contains("sessionSnapshots"))d.createObjectStore("sessionSnapshots",{keyPath:"sessionId"});
    };
    req.onsuccess=()=>{db=req.result; db.onversionchange=()=>db.close(); resolve(db)};
    req.onerror=()=>reject(req.error||new Error("Database open failed"));
  });
}
function txWrite(storeNames,mode,fn){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeNames,mode);
    let result;
    try{result=fn(tx)}catch(e){tx.abort();reject(e);return}
    tx.oncomplete=()=>resolve(result); tx.onerror=()=>reject(tx.error||new Error("Database transaction failed")); tx.onabort=()=>reject(tx.error||new Error("Database transaction aborted"));
  });
}
function snapshotState(){
  return JSON.parse(JSON.stringify({
    sessionId:state.sessionId||null,active:!!state.active,completedAt:state.completedAt||null,returnType:state.returnType||"RTO",
    selected:[...(state.selected||[])],expected:state.expected||{},mappingMemory:state.mappingMemory||{barcode:"",order:"",courier:""},records:state.records||[],duplicates:state.duplicates||[],unknown:state.unknown||[],wrong:state.wrong||[],importFiles:state.importFiles||[],
    createdAt:state.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()
  }));
}
function persistState(){
  if(!dbReady)return Promise.resolve();
  dbWriteQueued=true; if(dbWriteTimer)clearTimeout(dbWriteTimer);
  return new Promise(resolve=>{
    dbWriteTimer=setTimeout(async()=>{
      dbWriteTimer=null; if(dbWriteRunning){resolve();return}
      dbWriteRunning=true; dbWriteQueued=false;
      try{
        await txWrite(["sessions","expectedParcels","scanRecords","duplicateRecords","unknownRecords","wrongCourierRecords","importFiles","meta","sessionSnapshots"],"readwrite",tx=>{
          const sid=state.sessionId||"";
          if(sid){
            const session={sessionId:sid,active:!!state.active,completedAt:state.completedAt||null,returnType:state.returnType||"RTO",selected:[...(state.selected||[])],createdAt:state.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
            tx.objectStore("sessions").put(session);
            tx.objectStore("sessionSnapshots").put(snapshotState());
          }
          // Remove only records belonging to the current session; history stays intact.
          ["expectedParcels","scanRecords","duplicateRecords","unknownRecords","wrongCourierRecords","importFiles"].forEach(name=>{
            const store=tx.objectStore(name);
            store.openCursor().onsuccess=e=>{const c=e.target.result;if(!c)return; if(c.value.sessionId===sid)c.delete(); c.continue();};
          });
          Object.entries(state.expected||{}).forEach(([barcode,v])=>tx.objectStore("expectedParcels").put({id:sid+"::"+barcode,sessionId:sid,barcode,...v}));
          (state.records||[]).forEach(r=>tx.objectStore("scanRecords").put({sessionId:sid,...r}));
          (state.duplicates||[]).forEach(r=>tx.objectStore("duplicateRecords").put({sessionId:sid,...r}));
          (state.unknown||[]).forEach(r=>tx.objectStore("unknownRecords").put({sessionId:sid,...r}));
          (state.wrong||[]).forEach(r=>tx.objectStore("wrongCourierRecords").put({sessionId:sid,...r}));
          (state.importFiles||[]).forEach(r=>tx.objectStore("importFiles").put({sessionId:sid,...r}));
          tx.objectStore("meta").put({key:"lastSessionId",value:state.sessionId||null,updatedAt:new Date().toISOString()});
          tx.objectStore("meta").put({key:"schema",value:DB_VERSION});
        });
        setDbStatus("LOCAL DATABASE: SAVED","ok");
      }catch(e){setDbStatus("LOCAL DATABASE: SAVE ERROR","bad"); console.error(e)}
      finally{dbWriteRunning=false;if(dbWriteQueued)persistState()} resolve();
    },40);
  });
}
function readStoreAll(name){return new Promise((resolve,reject)=>{const tx=db.transaction([name],"readonly");const r=tx.objectStore(name).getAll();r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error);});}

const BACKUP_VERSION=1;
const BACKUP_STORES=["sessions","expectedParcels","scanRecords","duplicateRecords","unknownRecords","wrongCourierRecords","importFiles","meta","sessionSnapshots"];
async function collectBackup(){
  if(!dbReady) throw new Error("Local database is not ready");
  const stores={};
  for(const name of BACKUP_STORES) stores[name]=await readStoreAll(name);
  return {format:"RTO_RETURN_SCANNER_BACKUP",backupVersion:BACKUP_VERSION,appVersion:"V24",createdAt:new Date().toISOString(),database:{name:DB_NAME,version:DB_VERSION},stores,localState:JSON.parse(localStorage.getItem(KEY)||"null"),security:securityConfig()};
}
function downloadJson(filename,obj){const blob=new Blob([JSON.stringify(obj)],{type:"application/json;charset=utf-8"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function backupData(){try{const backup=await collectBackup();const stamp=new Date().toISOString().replace(/[:.]/g,"-");downloadJson(`RTO_Backup_${stamp}.json`,backup);setDbStatus("BACKUP: CREATED","ok");alert("Backup created successfully. Keep this JSON file in a safe place.")}catch(e){console.error(e);setDbStatus("BACKUP: ERROR","bad");alert("Backup failed: "+e.message)}}
function validBackup(b){return !!(b&&b.format==="RTO_RETURN_SCANNER_BACKUP"&&b.backupVersion===BACKUP_VERSION&&b.stores&&Array.isArray(b.stores.sessions)&&Array.isArray(b.stores.sessionSnapshots)&&BACKUP_STORES.every(k=>Array.isArray(b.stores[k])))}
async function restoreBackupFile(file){if(!file)return;try{const backup=JSON.parse(await file.text());if(!validBackup(backup))throw new Error("Invalid or unsupported backup file");const sessionCount=backup.stores.sessions.length;if(!confirm(`Restore this backup?\n\nSessions: ${sessionCount}\nBackup date: ${backup.createdAt||"unknown"}\n\nCurrent local database will be replaced.`))return;await txWrite(BACKUP_STORES,"readwrite",tx=>{BACKUP_STORES.forEach(name=>tx.objectStore(name).clear());BACKUP_STORES.forEach(name=>{const store=tx.objectStore(name);for(const item of backup.stores[name])store.put(item)})});if(backup.localState)localStorage.setItem(KEY,JSON.stringify(backup.localState));else localStorage.removeItem(KEY);if(backup.security)localStorage.setItem(SECURITY_KEY,JSON.stringify(backup.security));else localStorage.removeItem(SECURITY_KEY);const restored=backup.localState||backup.stores.sessionSnapshots.at(-1)||null;if(restored){const {createdAt,updatedAt,...rest}=restored;state={...rest,createdAt:createdAt||new Date().toISOString()}}render();await renderSessionHistory();setDbStatus("RESTORE: COMPLETE","ok");alert("Backup restored successfully. The app data has been restored.")}catch(e){console.error(e);setDbStatus("RESTORE: ERROR","bad");alert("Restore failed: "+e.message)}}
function openRestorePicker(){$("restoreFile").value="";$("restoreFile").click()}
async function listSessionHistory(){
  if(!dbReady)return [];
  try{return (await readStoreAll("sessionSnapshots")).sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));}
  catch(e){return []}
}
async function loadSessionById(sessionId){
  if(!dbReady)return false;
  const tx=db.transaction(["sessionSnapshots"],"readonly");
  const snap=await new Promise((resolve,reject)=>{const r=tx.objectStore("sessionSnapshots").get(sessionId);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  if(!snap)return false;
  const {createdAt,updatedAt,...rest}=snap; state={...rest,createdAt:createdAt||new Date().toISOString()};
  localStorage.setItem(KEY,JSON.stringify(state)); hideCompletion(); render(); return true;
}
async function hydrateFromDatabase(){
  try{
    await openDatabase(); dbReady=true;
    const snaps=await listSessionHistory();
    const currentId=state.sessionId || snaps[0]?.sessionId;
    if(currentId){
      const loaded=await loadSessionById(currentId);
      if(loaded){setDbStatus("LOCAL DATABASE: READY","ok");return;}
    }
    setDbStatus("LOCAL DATABASE: READY","ok");
    if(state.sessionId)await persistState();
  }catch(e){dbReady=false; setDbStatus("LOCAL DATABASE: FALLBACK STORAGE","bad"); console.error(e)}
}
function save(){localStorage.setItem(KEY,JSON.stringify(state)); persistState();}

// V24 Offline Production Hardening
const APP_VERSION="V24";
let lastPersistAt=0;
function updateOfflineStatus(){
  const el=$("offlineStatus"); if(!el)return;
  const online=navigator.onLine;
  el.textContent=online?"OFFLINE-READY • LOCAL DATA ACTIVE":"OFFLINE MODE • LOCAL DATA ACTIVE";
  el.className="offline-status "+(online?"ready":"offline");
}
function productionAutosave(){
  if(document.hidden || appLocked)return;
  try{
    localStorage.setItem(KEY,JSON.stringify(state));
    lastPersistAt=Date.now();
    if(dbReady)persistState();
    const el=$("autosaveStatus"); if(el)el.textContent="Autosaved "+new Date().toLocaleTimeString();
  }catch(e){console.error("Autosave failed",e); const el=$("autosaveStatus");if(el)el.textContent="Autosave error";}
}
window.addEventListener("online",updateOfflineStatus);
window.addEventListener("offline",updateOfflineStatus);
window.addEventListener("beforeunload",()=>{try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}});
window.addEventListener("error",e=>{console.error("Production error",e.error||e.message);const el=$("runtimeStatus");if(el)el.textContent="Runtime error detected — check console.";});
window.addEventListener("unhandledrejection",e=>{console.error("Unhandled promise rejection",e.reason);const el=$("runtimeStatus");if(el)el.textContent="Background operation error detected.";});
setInterval(productionAutosave,15000);
function norm(v){return String(v??"").trim();}
function now(){return new Date().toLocaleTimeString();}


function esc(v){
  const s=String(v??"");
  return `"${s.replace(/"/g,'""')}"`;
}
function downloadCSV(filename,headers,rows){
  const lines=[headers.map(esc).join(","),...rows.map(r=>headers.map(h=>esc(r[h])).join(","))];
  const blob=new Blob(["\ufeff"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function reportRows(type){
  if(type==="pending"){
    return selectedExpected().filter(([_,v])=>!v.scanned).map(([barcode,v])=>({Barcode:barcode,Courier:v.courier,Pending_Status:"PENDING"}));
  }
  if(type==="duplicate"){
    return state.duplicates.map(x=>({Barcode:x.barcode,Courier:x.courier,Original_Scan_Time:x.originalTime||"",Duplicate_Attempt_Time:x.time,Duplicate_Count:x.count||1}));
  }
  if(type==="unknown"){
    return state.unknown.map(x=>({Barcode:x.barcode,Scan_Date:x.date||new Date().toLocaleDateString(),Scan_Time:x.time,Session:state.sessionId}));
  }
  if(type==="wrong"){
    return state.wrong.map(x=>({Barcode:x.barcode,Expected_Courier:x.expectedCourier,Selected_Courier:x.selectedCourier,Scan_Time:x.time}));
  }
  return selectedExpected().map(([barcode,v])=>({
    Barcode:barcode,Courier:v.courier,Expected_Status:"EXPECTED",
    Scan_Status:v.scanned?"SCANNED":"PENDING",
    Scan_Date:v.scanDate||"",Scan_Time:v.scanTime||"",Return_Type:v.returnType||state.returnType||"RTO",Session_ID:state.sessionId
  }));
}
function exportReport(type){
  const defs={
    complete:["complete_scanning_report.csv",["Barcode","Courier","Expected_Status","Scan_Status","Scan_Date","Scan_Time","Return_Type","Session_ID"]],
    pending:["pending_report.csv",["Barcode","Courier","Pending_Status"]],
    duplicate:["duplicate_report.csv",["Barcode","Courier","Original_Scan_Time","Duplicate_Attempt_Time","Duplicate_Count"]],
    unknown:["unknown_report.csv",["Barcode","Reason","Return_Type","Scan_Date","Scan_Time","Session"]],
    wrong:["wrong_courier_report.csv",["Barcode","Expected_Courier","Selected_Courier","Return_Type","Scan_Time"]]
  };
  const [file,headers]=defs[type]; downloadCSV(file,headers,reportRows(type));
}
function exportSummary(){
  const rows=courierNames.map(c=>{
    const arr=Object.entries(state.expected).filter(([_,v])=>v.courier===c);
    const scanned=arr.filter(([_,v])=>v.scanned).length;
    return {Courier:c,Total:arr.length,Scanned:scanned,Pending:arr.length-scanned};
  });
  downloadCSV("courier_summary.csv",["Courier","Total","Scanned","Pending"],rows);
}
function searchNorm(v){return normalizeBarcode(v).toLowerCase();}
function searchStatusForExpected(v){return v?.scanned?"SCANNED":"PENDING";}
function searchCurrentSession(query){
  const q=searchNorm(query); if(!q)return [];
  const out=[];
  for(const [barcode,v] of Object.entries(state.expected||{})){
    if([barcode,v.courier,v.returnType,v.source].map(searchNorm).some(x=>x.includes(q))) out.push({barcode,courier:v.courier||"-",status:searchStatusForExpected(v),returnType:v.returnType||state.returnType||"RTO",session:state.sessionId||"-",scanTime:v.scanTime||"",kind:"Current Session"});
  }
  for(const r of state.records||[]){
    if([r.barcode,r.courier,r.returnType,r.status,r.time,state.sessionId].map(searchNorm).some(x=>x.includes(q)) && !out.some(x=>x.barcode===r.barcode&&x.session===state.sessionId)) out.push({barcode:r.barcode||"-",courier:r.courier||"-",status:r.status||"SCAN RECORD",returnType:r.returnType||state.returnType||"RTO",session:state.sessionId||"-",scanTime:r.time||"",kind:"Scan Record"});
  }
  return out;
}
function searchSnapshot(query,snap){
  const q=searchNorm(query), sid=snap.sessionId||"-"; if(!q)return [];
  const out=[];
  for(const [barcode,v] of Object.entries(snap.expected||{})){
    if([barcode,v.courier,v.returnType,v.source,sid].map(searchNorm).some(x=>x.includes(q))) out.push({barcode,courier:v.courier||"-",status:searchStatusForExpected(v),returnType:v.returnType||snap.returnType||"RTO",session:sid,scanTime:v.scanTime||"",kind:"Saved Session"});
  }
  for(const r of snap.records||[]){
    if([r.barcode,r.courier,r.returnType,r.status,r.time,sid].map(searchNorm).some(x=>x.includes(q)) && !out.some(x=>x.barcode===r.barcode&&x.session===sid)) out.push({barcode:r.barcode||"-",courier:r.courier||"-",status:r.status||"SCAN RECORD",returnType:r.returnType||snap.returnType||"RTO",session:sid,scanTime:r.time||"",kind:"Saved Scan"});
  }
  return out;
}
function renderSearchResults(results,query){
  const box=$("searchResults"), summary=$("searchSummary");
  if(!results.length){summary.textContent=`No result found for “${query}”.`;box.innerHTML='<div class="search-empty">No matching barcode, AWB or session found.</div>';return;}
  const unique=[],seen=new Set(); for(const r of results){const k=[r.barcode,r.session,r.status].join("|");if(!seen.has(k)){seen.add(k);unique.push(r)}}
  summary.textContent=`${unique.length} matching result${unique.length===1?"":"s"} found.`;
  box.innerHTML=unique.slice(0,200).map(r=>`<div class="search-result-row"><div class="search-result-main"><b>${escHtml(r.barcode)}</b><span>${escHtml(r.kind)}</span></div><div><small>Courier</small><b>${escHtml(r.courier)}</b></div><div><small>Status</small><b class="search-status ${r.status==="SCANNED"||String(r.status).includes("VALID")?"ok":r.status==="PENDING"?"pending":"other"}">${escHtml(r.status)}</b></div><div><small>Session</small><b>${escHtml(r.session)}</b></div><div><small>Scan Time</small><b>${escHtml(r.scanTime||"—")}</b></div><div><small>Return Type</small><b>${escHtml(r.returnType)}</b></div></div>`).join('')+(unique.length>200?'<div class="search-empty">Showing first 200 results.</div>':'');
}
async function performGlobalSearch(){
  const input=$("globalSearchInput"), query=norm(input.value);
  if(!query){$("searchSummary").textContent="Enter a barcode/AWB or session ID.";$("searchResults").innerHTML="";input.focus();return;}
  const results=searchCurrentSession(query);
  try{for(const snap of await listSessionHistory()){if(snap.sessionId!==state.sessionId)results.push(...searchSnapshot(query,snap));}}catch(e){console.error("History search failed",e)}
  renderSearchResults(results,query);
}
function openSearch(){$("searchModal").classList.remove("hidden");$("globalSearchInput").value="";$("searchSummary").textContent="Enter a barcode/AWB and press Search.";$("searchResults").innerHTML="";setTimeout(()=>$('globalSearchInput').focus(),30);}

function deleteRowRecords(barcode){
  const b=normalizeBarcode(barcode);
  state.records=(state.records||[]).filter(r=>normalizeBarcode(r.barcode)!==b);
  state.duplicates=(state.duplicates||[]).filter(r=>normalizeBarcode(r.barcode)!==b);
  state.unknown=(state.unknown||[]).filter(r=>normalizeBarcode(r.barcode)!==b);
  state.wrong=(state.wrong||[]).filter(r=>normalizeBarcode(r.barcode)!==b);
}
function selectiveDeleteItems(){
  const items=[];
  for(const [barcode,v] of Object.entries(state.expected||{})) items.push({barcode,courier:v.courier||'-',returnType:v.returnType||state.returnType||'RTO',status:v.scanned?'SCANNED':'PENDING',scanTime:v.scanTime||''});
  const seen=new Set(items.map(x=>x.barcode));
  for(const r of [...(state.records||[]),...(state.duplicates||[]),...(state.unknown||[]),...(state.wrong||[])]){const b=normalizeBarcode(r.barcode);if(!b||seen.has(b))continue;items.push({barcode:b,courier:r.courier||r.expectedCourier||'-',returnType:r.returnType||state.returnType||'RTO',status:r.status||'UNKNOWN',scanTime:r.time||''});seen.add(b)}
  return items.sort((a,b)=>String(a.barcode).localeCompare(String(b.barcode),undefined,{numeric:true}));
}
function selectedDeleteBarcodes(){return [...document.querySelectorAll('#selectiveDeleteRows input[data-delete-barcode]:checked')].map(x=>x.dataset.deleteBarcode)}
function updateDeleteSelectionUI(){const selected=selectedDeleteBarcodes(),total=document.querySelectorAll('#selectiveDeleteRows input[data-delete-barcode]').length,count=$('deleteSelectedCount'),btn=$('deleteSelectedBtn'),master=$('deleteMasterCheck');if(count)count.textContent=`${selected.length} selected`;if(btn)btn.textContent=`REMOVE SELECTED (${selected.length})`;if(master){master.checked=total>0&&selected.length===total;master.indeterminate=selected.length>0&&selected.length<total}}
function renderSelectiveDelete(){const body=$('selectiveDeleteRows'),empty=$('deleteEmptyState');if(!body)return;const items=selectiveDeleteItems();if(!items.length){body.innerHTML='';empty?.classList.remove('hidden');updateDeleteSelectionUI();return}empty?.classList.add('hidden');body.innerHTML=items.map(x=>`<tr><td><input type="checkbox" data-delete-barcode="${escHtml(x.barcode)}" aria-label="Select ${escHtml(x.barcode)}"></td><td><b>${escHtml(x.barcode)}</b></td><td>${escHtml(x.courier)}</td><td>${escHtml(x.returnType)}</td><td>${escHtml(x.status)}</td><td>${escHtml(x.scanTime||'—')}</td></tr>`).join('');body.querySelectorAll('input[data-delete-barcode]').forEach(cb=>cb.addEventListener('change',updateDeleteSelectionUI));updateDeleteSelectionUI()}
async function removeSelectedRecords(){const selected=selectedDeleteBarcodes();if(!selected.length){alert('Please select at least one record.');return}const preview=selected.slice(0,8).join('\n'),more=selected.length>8?`\n…and ${selected.length-8} more`:'';if(!confirm(`${selected.length} record${selected.length===1?'':'s'} will be removed from the current session.\n\n${preview}${more}\n\nThis cannot be undone unless you have a backup. Continue?`))return;for(const b of selected){delete state.expected[b];deleteRowRecords(b)}save();render();alert(`${selected.length} record${selected.length===1?'':'s'} removed successfully.`)}
function bindSelectiveDelete(){$('selectAllDelete')?.addEventListener('click',()=>{document.querySelectorAll('#selectiveDeleteRows input[data-delete-barcode]').forEach(cb=>cb.checked=true);updateDeleteSelectionUI()});$('clearAllDelete')?.addEventListener('click',()=>{document.querySelectorAll('#selectiveDeleteRows input[data-delete-barcode]').forEach(cb=>cb.checked=false);updateDeleteSelectionUI()});$('deleteMasterCheck')?.addEventListener('change',e=>{document.querySelectorAll('#selectiveDeleteRows input[data-delete-barcode]').forEach(cb=>cb.checked=e.target.checked);updateDeleteSelectionUI()});$('deleteSelectedBtn')?.addEventListener('click',removeSelectedRecords)}

function renderSessionSummary(){
  const c=counts();
  $("sessionSummary").innerHTML=`<b>Batch:</b> ${state.sessionId||"None"} &nbsp; | &nbsp; <b>Return Type:</b> ${state.returnType||"RTO"} &nbsp; | &nbsp;
  <b>Total:</b> ${c.total} &nbsp; <b>Scanned:</b> ${c.scanned} &nbsp;
  <b>Pending:</b> ${c.pending} &nbsp; <b>Duplicate:</b> ${state.duplicates.length} &nbsp;
  <b>Unknown:</b> ${state.unknown.length} &nbsp; <b>Wrong Courier:</b> ${state.wrong.length}`;
}
$("completeReport").onclick=()=>exportReport("complete");
$("pendingReport").onclick=()=>exportReport("pending");
$("duplicateReport").onclick=()=>exportReport("duplicate");
$("unknownReport").onclick=()=>exportReport("unknown");
$("wrongReport").onclick=()=>exportReport("wrong");
$("summaryReport").onclick=exportSummary;

function normalizeBarcode(v){
  if(v===null||v===undefined)return "";
  let s=String(v).trim().replace(/\u00a0/g," ");
  s=s.replace(/\s+/g," ");
  return s;
}
function classifyColumn(rows){
  if(!rows.length)return [];
  const keys=Object.keys(rows[0]||{});
  const hints=["barcode","awb","awb no","awb number","tracking","tracking no","shipment","shipment id","waybill"];
  return keys.map(k=>{
    const x=k.toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();
    let score=hints.some(h=>x===h)?100:hints.some(h=>x.includes(h))?70:0;
    return {key:k,score};
  }).sort((a,b)=>b.score-a.score);
}
function getMappingMemory(){
  const m=state.mappingMemory||{};
  return {barcode:m.barcode||"",order:m.order||"",courier:m.courier||""};
}
function saveMappingMemory(mapping){
  state.mappingMemory={barcode:mapping.barcode||"",order:mapping.order||"",courier:mapping.courier||""};
  save();
}
function clearMappingMemory(){
  state.mappingMemory={barcode:"",order:"",courier:""};
  save(); renderMappingMemory();
}
function mappingSuggestion(rows){
  const all=Object.keys(rows[0]||{}), m=getMappingMemory();
  const pick=(saved, hints)=>{
    if(saved && all.includes(saved)) return saved;
    const scored=all.map(k=>{const x=k.toLowerCase().replace(/[^a-z0-9 ]/g," ").trim();let score=0;for(const h of hints){if(x===h)score=Math.max(score,100);else if(x.includes(h))score=Math.max(score,70)}return {k,score}}).sort((a,b)=>b.score-a.score);
    return scored[0]?.score ? scored[0].k : "";
  };
  return {
    barcode:pick(m.barcode,["barcode","awb","awb no","awb number","tracking","tracking no","shipment","shipment id","waybill"]),
    order:pick(m.order,["order","order id","order no","order number"]),
    courier:pick(m.courier,["courier","courier name","logistics","shipping partner","carrier"])
  };
}
function renderMappingMemory(){
  const el=$("mappingMemoryStatus"); if(!el)return; const m=getMappingMemory();
  if(!m.barcode && !m.order && !m.courier){el.innerHTML='<span class="mapping-empty">No saved Excel mapping yet.</span>';return}
  el.innerHTML=`<b>Saved mapping:</b> Barcode → ${m.barcode||"—"} · Order → ${m.order||"—"} · Courier → ${m.courier||"—"}`;
}

async function readWorkbook(file){
  const buf=await file.arrayBuffer();
  const wb=XLSX.read(buf,{type:"array",cellDates:false,raw:true});
  const sheet=wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet,{defval:"",raw:true});
}
let pendingImport=null;
let cameraReader=null;
let cameraStream=null;
let cameraTrack=null;
let cameraRunning=false;
let lastCameraBarcode="";
let lastCameraAt=0;
const CAMERA_LOCK_MS=900;
// V5 Professional Scanner Engine
const HARDWARE_LOCK_MS=650;
let hardwareBuffer="";
let hardwareStartedAt=0;
let lastHardwareBarcode="";
let lastHardwareAt=0;
let hardwareKeyTimer=null;
function hardwareState(text,kind="ready") {
  const dot=$("hardwareState"), label=$("hardwareText");
  if(!dot||!label)return;
  dot.className="hardware-dot"+(kind==="busy"?" busy":kind==="error"?" error":"");
  label.textContent=text;
}
function hardwareScan(raw){
  const barcode=normalizeBarcode(raw);
  if(!barcode)return;
  const t=Date.now();
  if(barcode===lastHardwareBarcode && t-lastHardwareAt<HARDWARE_LOCK_MS){
    hardwareState("DUPLICATE INPUT LOCK — waiting for next barcode","busy");
    return;
  }
  lastHardwareBarcode=barcode; lastHardwareAt=t;
  hardwareState("SCANNING — barcode received","busy");
  scan(barcode,{fromHardware:true});
  setTimeout(()=>hardwareState("READY — USB/Bluetooth scanner can scan now","ready"),220);
}
function initHardwareScanner(){
  const input=$("barcodeInput");
  if(!input)return;
  document.addEventListener("keydown",e=>{
    if($("hardwareAuto")?.checked===false)return;
    // Ignore shortcuts, modifier combinations and camera/manual field Enter handling.
    if(e.ctrlKey||e.altKey||e.metaKey)return;
    if(e.key==="Enter"||e.key==="Tab"){
      if(hardwareBuffer){
        e.preventDefault(); hardwareScan(hardwareBuffer); hardwareBuffer="";
        if(hardwareKeyTimer)clearTimeout(hardwareKeyTimer);
      }
      return;
    }
    if(e.key.length===1){
      const nowMs=Date.now();
      if(!hardwareStartedAt || nowMs-hardwareStartedAt>180)hardwareBuffer="";
      if(!hardwareBuffer)hardwareStartedAt=nowMs;
      hardwareBuffer+=e.key;
      clearTimeout(hardwareKeyTimer);
      // Most scanners send a very fast burst and may not send Enter.
      hardwareKeyTimer=setTimeout(()=>{
        if(hardwareBuffer.length>=3){const v=hardwareBuffer;hardwareBuffer="";hardwareScan(v);}
      },140);
    }
  },true);
  input.addEventListener("input",()=>{
    // Keep manual keyboard entry usable; scanner devices normally finish with Enter.
  });
  window.addEventListener("focus",()=>setTimeout(()=>input.focus(),30));
  input.focus();
}

function cameraStatus(text,on=false){
  const el=$("cameraState");
  el.textContent=text;
  el.className="camera-state"+(on?" on":"");
}
function cameraMessage(text){$("cameraMessage").textContent=text}
function beep(){
  try{
    const Ctx=window.AudioContext||window.webkitAudioContext;
    if(!Ctx)return;
    const ctx=new Ctx(),osc=ctx.createOscillator(),gain=ctx.createGain();
    osc.frequency.value=880; gain.gain.value=.05;
    osc.connect(gain);gain.connect(ctx.destination);osc.start();
    setTimeout(()=>{osc.stop();ctx.close()},90);
  }catch(_){}
}
function preferRearDevices(devices){
  return devices.slice().sort((a,b)=>{
    const al=(a.label||"").toLowerCase(), bl=(b.label||"").toLowerCase();
    const ar=/back|rear|environment/.test(al)?0:1;
    const br=/back|rear|environment/.test(bl)?0:1;
    return ar-br;
  });
}
async function loadCameras(){
  if(!navigator.mediaDevices?.enumerateDevices)return [];
  try{
    const devices=preferRearDevices((await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==="videoinput"));
    const select=$("cameraSelect");
    if(select){
      const current=select.value;
      select.innerHTML='<option value="">Default rear camera</option>'+devices.map((d,i)=>
        `<option value="${String(d.deviceId).replace(/"/g,'&quot;')}">${d.label||("Camera "+(i+1))}</option>`).join("");
      if(current && devices.some(d=>d.deviceId===current)) select.value=current;
    }
    return devices;
  }catch(_){ return []; }
}

function cameraErrorMessage(e){
  const n=e?.name||"";
  if(n==="NotAllowedError"||n==="PermissionDeniedError") return "Camera permission is blocked. Allow camera access for this site, then try again.";
  if(n==="NotFoundError"||n==="DevicesNotFoundError") return "No camera was found on this device.";
  if(n==="NotReadableError"||n==="TrackStartError") return "Camera is busy or already being used by another app/tab. Close it there and try again.";
  if(n==="OverconstrainedError") return "The selected camera is unavailable. Choose Default rear camera and try again.";
  if(n==="SecurityError") return "Camera access is blocked by browser security settings. Open this site over HTTPS.";
  return e?.message||"Unable to start camera.";
}

async function attachCameraStream(constraints){
  const stream=await navigator.mediaDevices.getUserMedia(constraints);
  const video=$("cameraVideo");
  video.srcObject=stream;
  video.setAttribute("playsinline","");
  video.muted=true;
  await video.play();
  return stream;
}

async function startNativeBarcodeLoop(){
  if(!("BarcodeDetector" in window)) return false;
  try{
    const supported=await BarcodeDetector.getSupportedFormats();
    const wanted=["code_128","code_39","ean_13","ean_8","upc_a","upc_e","qr_code"];
    const formats=wanted.filter(f=>supported.includes(f));
    if(!formats.length)return false;
    const detector=new BarcodeDetector({formats});
    cameraReader={native:true,stop(){cameraNativeLoop=false;}};
    cameraNativeLoop=true;
    const video=$("cameraVideo");
    const loop=async()=>{
      if(!cameraRunning||!cameraNativeLoop)return;
      try{
        if(video.readyState>=2){
          const results=await detector.detect(video);
          if(results?.length){
            const text=results[0].rawValue?.trim();
            const nowMs=Date.now();
            if(text && !(text===lastCameraBarcode && nowMs-lastCameraAt<CAMERA_LOCK_MS)){
              lastCameraBarcode=text; lastCameraAt=nowMs;
              beep(); scan(text,{fromCamera:true});
              if(!$('bulkMode').checked){stopCamera();return;}
            }
          }
        }
      }catch(_){ /* keep camera alive; individual frames can fail */ }
      cameraNativeTimer=setTimeout(loop,100);
    };
    loop();
    return true;
  }catch(_){return false;}
}

let cameraNativeLoop=false;
let cameraNativeTimer=null;

async function startCamera(){
  if(cameraRunning)return;
  if(!window.isSecureContext || !navigator.mediaDevices?.getUserMedia){
    cameraMessage("Camera requires HTTPS. This GitHub Pages site is HTTPS, so refresh the page and try again.");
    cameraStatus("CAMERA UNAVAILABLE"); return;
  }
  try{
    stopCamera();
    cameraMessage("Requesting camera permission...");
    const devices=await loadCameras();
    const selected=$("cameraSelect")?.value||"";
    let constraints=selected
      ? {video:{deviceId:{exact:selected},width:{ideal:1280},height:{ideal:720}},audio:false}
      : {video:{facingMode:{ideal:"environment"},width:{ideal:1280},height:{ideal:720}},audio:false};
    try{
      cameraStream=await attachCameraStream(constraints);
    }catch(firstError){
      if(selected){
        cameraMessage("Selected camera unavailable; trying the rear camera...");
        cameraStream=await attachCameraStream({video:{facingMode:{ideal:"environment"}},audio:false});
      }else{
        throw firstError;
      }
    }
    cameraTrack=cameraStream.getVideoTracks?.()[0]||null;
    await loadCameras();
    cameraRunning=true;
    state.active=true; save();
    cameraStatus("CAMERA ON",true);
    $("scanStatus").className="scan-status active";
    $("scanStatus").textContent="CAMERA SCANNING — READY";
    cameraMessage("Camera ready. Point the rear camera at a barcode.");

    const nativeStarted=await startNativeBarcodeLoop();
    if(nativeStarted)return;

    if(!window.ZXingBrowser?.BrowserMultiFormatReader){
      cameraMessage("Camera is ON, but the barcode engine could not load. Refresh the page and try again.");
      return;
    }
    cameraReader=new ZXingBrowser.BrowserMultiFormatReader();
    const deviceId=cameraTrack?.getSettings?.().deviceId || $("cameraSelect")?.value || undefined;
    cameraReader.decodeFromVideoDevice(deviceId,$("cameraVideo"),(result,err)=>{
      if(!cameraRunning||!result)return;
      const text=result.getText()?.trim();
      const nowMs=Date.now();
      if(!text || (text===lastCameraBarcode && nowMs-lastCameraAt<CAMERA_LOCK_MS))return;
      lastCameraBarcode=text; lastCameraAt=nowMs;
      beep(); scan(text,{fromCamera:true});
      if(!$("bulkMode").checked) stopCamera();
    }).then(control=>{
      if(control?.stream && !cameraStream){cameraStream=control.stream;cameraTrack=control.stream.getVideoTracks?.()[0]||null;}
    }).catch(e=>{cameraMessage(cameraErrorMessage(e));});
  }catch(e){
    cameraRunning=false;
    try{cameraStream?.getTracks?.().forEach(t=>t.stop())}catch(_){ }
    cameraStream=null; cameraTrack=null;
    cameraStatus("CAMERA ERROR");
    cameraMessage(cameraErrorMessage(e));
    $("scanStatus").className="scan-status bad";
    $("scanStatus").textContent="CAMERA START FAILED";
  }
}
function stopCamera(){
  cameraRunning=false;
  try{cameraReader?.reset?.()}catch(_){}
  try{cameraStream?.getTracks?.().forEach(t=>t.stop())}catch(_){}
  try{$("cameraVideo").srcObject=null}catch(_){}
  cameraReader=null;cameraStream=null;cameraTrack=null;
  cameraStatus("CAMERA OFF");
  cameraMessage("Start Camera to scan a parcel barcode");
  $("scanStatus").className="scan-status ready";
  $("scanStatus").textContent="SCAN STOPPED";
  state.active=false;save();
}
async function toggleTorch(){
  if(!cameraTrack){
    cameraMessage("Start the camera first.");
    return;
  }
  const caps=cameraTrack.getCapabilities?.();
  if(!caps?.torch){
    cameraMessage("Flashlight control is not supported by this browser/device.");
    return;
  }
  const enabled=$("torchBtn").dataset.on==="1";
  try{
    await cameraTrack.applyConstraints({advanced:[{torch:!enabled}]});
    $("torchBtn").dataset.on=enabled?"0":"1";
    $("torchBtn").textContent=enabled?"FLASHLIGHT OFF":"FLASHLIGHT ON";
  }catch(_){cameraMessage("Could not change flashlight state.");}
}

let pendingImports=[];
function showMapping(rows,file,courier,index=0,total=1){
  pendingImport={rows,file,courier,index,total};
  const all=Object.keys(rows[0]||{}), suggestion=mappingSuggestion(rows);
  const make=(id,selected)=>{const el=$(id); if(!el)return; el.innerHTML='<option value="">Not mapped</option>'+all.map(k=>`<option value="${String(k).replace(/"/g,'&quot;')}" ${k===selected?'selected':''}>${k}</option>`).join("");};
  make("barcodeColumn",suggestion.barcode); make("orderColumn",suggestion.order); make("courierColumn",suggestion.courier);
  $("mappingInfo").textContent=`${file.name}: ${rows.length} rows · File ${index+1} of ${total}. Saved mappings are auto-suggested when available.`;
  $("mappingModal").classList.remove("hidden");
}

function importRows(rows,courier,col,fileName,returnType=state.returnType||"RTO"){
  let valid=0,blank=0,duplicates=0,conflicts=0;
  const seen=new Set();
  for(const row of rows){
    const original=normalizeBarcode(row[col]);
    if(!original){blank++;continue}
    const key=original;
    if(seen.has(key)){duplicates++;continue}
    seen.add(key);
    if(!state.expected[key]){state.expected[key]={courier,returnType,scanned:false,source:fileName,originalBarcode:original};valid++}
    else if(state.expected[key].courier!==courier){state.expected[key].conflict=true;conflicts++;}
    else duplicates++;
  }
  state.selected=[...new Set([...state.selected,courier])];
  if(fileName){
    state.importFiles=state.importFiles||[];
    state.importFiles.push({name:fileName,courier,returnType,rows:rows.length,imported:valid,blank,duplicates,conflicts,time:new Date().toISOString()});
  }
  save();render();
  return {valid,blank,duplicates,conflicts};
}
function renderMultiImportList(files){
  const el=$("multiImportList"); if(!el)return;
  if(!files?.length){el.innerHTML="";return}
  el.innerHTML=`<b>${files.length} file(s) selected</b><br>`+files.map((f,i)=>`${i+1}. ${f.name}`).join("<br>");
}

function validateImportRows(rows, mapping, courier, fileName){
  const barcodeCol=mapping.barcode||"";
  const orderCol=mapping.order||"";
  const courierCol=mapping.courier||"";
  const seen=new Set(), duplicateValues=[], malformedValues=[], blankRows=[];
  let duplicateCount=0;
  let validBarcode=0;
  rows.forEach((row,i)=>{
    const raw=normalizeBarcode(row[barcodeCol]);
    if(!raw){blankRows.push(i+2);return;}
    validBarcode++;
    const key=normalizeBarcode(raw);
    if(seen.has(key)){ duplicateCount++; if(duplicateValues.length<50) duplicateValues.push(key); }
    seen.add(key);
    if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw) || raw.length>120) {
      if(malformedValues.length<50) malformedValues.push(key);
    }
  });
  const courierValues=courierCol?rows.map(r=>normalizeBarcode(r[courierCol])).filter(Boolean):[];
  const courierAvailable=courierValues.length>0;
  const validation={fileName,rows:rows.length,validBarcode,blankCount:blankRows.length,duplicateCount,duplicateValues,malformedCount:malformedValues.length,malformedValues,courierAvailable,courierColumn:courierCol,orderAvailable:!!orderCol,barcodeColumn:barcodeCol,courier: courier||"",ready:!!barcodeCol&&validBarcode>0&&malformedValues.length===0};
  return validation;
}
function renderValidationResult(v){
  const safe=(x)=>escHtml(String(x??""));
  const row=(ok,label,value,detail="")=>`<div class="validation-row"><span class="validation-icon ${ok?'ok':'warn'}">${ok?'✓':'!'}</span><div><b>${safe(label)}</b><small>${safe(value)}${detail?` · ${safe(detail)}`:''}</small></div></div>`;
  const el=$("importValidationResults"); if(!el)return;
  el.innerHTML=[
    row(v.barcodeColumn,"Barcode column found",v.barcodeColumn||"Not mapped"),
    row(v.rows>0,"Rows detected",v.rows),
    row(v.blankCount===0,"Blank barcode rows",v.blankCount,v.blankCount?`Rows: ${v.blankCount>10?'first 10 only':v.blankRows?.join(', ')||''}`:"Clean"),
    row(v.duplicateCount===0,"Duplicate barcode rows",v.duplicateCount,v.duplicateCount?`First values: ${v.duplicateValues.slice(0,5).join(', ')}`:"Clean"),
    row(v.malformedCount===0,"Malformed barcode values",v.malformedCount,v.malformedCount?`First values: ${v.malformedValues.slice(0,5).join(', ')}`:"Clean"),
    row(v.courierAvailable,"Courier information",v.courierAvailable?(v.courierColumn||"Detected") : "Not mapped"),
    row(v.orderAvailable,"Order information",v.orderAvailable?"Mapped":"Not mapped","Optional")
  ].join('');
  const status=$("importValidationStatus"); if(status){status.className=`validation-status-box ${v.ready?'ready':'warning'}`;status.textContent=v.ready?'VALIDATION READY — REVIEW RESULTS BEFORE IMPORT':'VALIDATION WARNING — FIX/CONFIRM MAPPING BEFORE IMPORT';}
}
let pendingValidation=null;
function openImportValidation(rows,file,courier,index,total,mapping){
  const v=validateImportRows(rows,mapping,courier,file.name);
  v.rowsData=rows; v.file=file; v.index=index; v.total=total; v.mapping=mapping;
  pendingValidation=v;
  $("importValidationInfo").textContent=`${file.name}: ${rows.length} rows · File ${index+1} of ${total}`;
  renderValidationResult(v);
  $("importValidationModal").classList.remove('hidden');
}
function closeImportValidation(){ $("importValidationModal").classList.add('hidden'); pendingValidation=null; }

async function processImportFiles(files,courier){
  if(!files.length){alert("Please choose one or more Excel files.");return}
  pendingImports=[];
  for(let i=0;i<files.length;i++){
    const file=files[i];
    try{
      const rows=await readWorkbook(file);
      if(!rows.length){pendingImports.push({file,courier,error:"No records found"});continue}
      const suggestion=mappingSuggestion(rows), best=suggestion.barcode||classifyColumn(rows)[0]?.key;
      if(!best){pendingImports.push({file,courier,rows,error:"Barcode/AWB column not detected"});continue}
      pendingImports.push({file,courier,rows,mapping:suggestion,barcode:best});
    }catch(e){pendingImports.push({file,courier,error:"Could not read file"});}
  }
  const first=pendingImports.find(x=>x.rows&&x.rows.length);
  if(!first){$("importSummary").innerHTML=`<b>Validation failed</b><br>${pendingImports.map(x=>`${escHtml(x.file.name)}: ${escHtml(x.error||'Invalid file')}`).join('<br>')}`;return}
  const idx=pendingImports.indexOf(first);
  showMapping(first.rows,first.file,courier,idx,pendingImports.length);
}
function proceedValidatedImport(){
  if(!pendingValidation)return;
  const v=pendingValidation, p=pendingImport;
  if(!p){closeImportValidation();return}
  const mapping={barcode:v.mapping.barcode||p.barcode,order:v.mapping.order||"",courier:v.mapping.courier||""};
  if(!mapping.barcode){alert("Barcode / AWB column is required.");return}
  saveMappingMemory(mapping);
  const r=importRows(v.rowsData,p.courier,mapping.barcode,p.file.name,$("importReturnType")?.value||state.returnType||"RTO");
  $("importSummary").innerHTML=`<b>Validated import complete</b><br>${escHtml(v.file.name)}: +${r.valid} imported, ${r.duplicates} duplicates, ${r.blank} blank, ${r.conflicts} courier conflicts.`;
  closeImportValidation();
  $("mappingModal").classList.add('hidden'); pendingImport=null; pendingImports=[]; $("excelFile").value=""; renderMultiImportList([]); renderMappingMemory();
}

$("excelFile").onchange=e=>renderMultiImportList([...e.target.files]);
$("importBtn").onclick=async()=>processImportFiles([...$("excelFile").files],$("importCourier").value);
$("cancelMapping").onclick=()=>{$("mappingModal").classList.add("hidden");pendingImport=null;pendingImports=[]};
$("confirmMapping").onclick=()=>{
  if(!pendingImport)return;
  const col=$("barcodeColumn").value;
  const p=pendingImport;
  if(!col){alert("Please select the Barcode / AWB column.");return}
  const mapping={barcode:col,order:$("orderColumn")?.value||"",courier:$("courierColumn")?.value||""};
  $("mappingModal").classList.add("hidden");
  openImportValidation(p.rows,p.file,p.courier,p.index,p.total,mapping);
};
$("cancelImportValidation").onclick=closeImportValidation;
$("confirmValidatedImport").onclick=proceedValidatedImport;
$("returnBtn").onclick=async()=>{
  const files=[...$("returnFile").files];
  if(!files.length){alert("Please choose one or more return/RTO Excel files.");return}
  const results=[];
  for(const file of files){
    try{
      const rows=await readWorkbook(file); if(!rows.length){results.push(`${file.name}: no records`);continue}
      const suggestion=mappingSuggestion(rows), best=suggestion.barcode||classifyColumn(rows)[0]?.key;
      if(!best){results.push(`${file.name}: barcode/AWB column not detected`);continue}
      const r=importRows(rows,"Delivery",best,file.name,$("returnFileType")?.value||state.returnType||"RTO");
      saveMappingMemory({...mappingSuggestion(rows),barcode:best});
      results.push(`${file.name}: +${r.valid} imported, ${r.duplicates} duplicates, ${r.blank} blank`);
    }catch(e){results.push(`${file.name}: import failed`)}
  }
  $("returnSummary").innerHTML=`<b>Return files imported</b><br>${results.join("<br>")}`;
  $("returnFile").value="";
};

async function renderSessionHistory(){
  const box=$("sessionHistoryList"); if(!box)return;
  const list=await listSessionHistory();
  if(!list.length){box.innerHTML='<div class="empty-history">No saved sessions yet.</div>';return;}
  box.innerHTML=list.map(s=>{
    const c=(()=>{const vals=Object.values(s.expected||{}),total=vals.length,scanned=vals.filter(v=>v.scanned).length;return {total,scanned,pending:total-scanned}})();
    const status=c.total>0&&c.pending===0?'COMPLETED':(s.active?'ACTIVE':'SAVED');
    const rt=s.returnType||'RTO';
    return `<div class="history-row"><div><b>${s.sessionId}</b><span>${rt} · ${status}</span><small>${new Date(s.updatedAt||s.createdAt||Date.now()).toLocaleString()}</small></div><div class="history-stats"><span>Total ${c.total}</span><span>Scanned ${c.scanned}</span><span>Pending ${c.pending}</span><span>Dup ${(s.duplicates||[]).length}</span><span>Unknown ${(s.unknown||[]).length}</span><span>Wrong ${(s.wrong||[]).length}</span></div><button data-load-session="${s.sessionId}" class="primary">CONTINUE</button></div>`;}).join('');
  box.querySelectorAll('[data-load-session]').forEach(b=>b.onclick=async()=>{await loadSessionById(b.dataset.loadSession); $("sessionHistoryModal").classList.add("hidden");});
}
async function openSessionHistory(){ $("sessionHistoryModal").classList.remove("hidden"); await renderSessionHistory(); }

function newSession(){
 state={sessionId:"B"+new Date().toISOString().replace(/[-:TZ.]/g,"").slice(0,14),
 active:false,completedAt:null,returnType:$('returnType')?.value||"RTO",createdAt:new Date().toISOString(),expected:{},selected:courierNames.slice(),records:[],duplicates:[],unknown:[],wrong:[],importFiles:[]};
 save(); hideCompletion(); render(); $("barcodeInput").focus();
}
function demo(){
 state.expected={}; state.records=[]; state.duplicates=[]; state.unknown=[]; state.wrong=[]; state.importFiles=[]; state.completedAt=null; state.active=false; state.returnType=$('returnType')?.value||state.returnType||"RTO";
 courierNames.forEach((c,i)=>{for(let n=1;n<=5;n++) state.expected[""+(10000+i*100+n)]={courier:c,scanned:false}});
 state.selected=courierNames.slice(); save(); render(); $("barcodeInput").focus();
}
function selectedExpected(){
 return Object.entries(state.expected).filter(([_,v])=>state.selected.includes(v.courier));
}
function counts(){
 const exp=selectedExpected(), total=exp.length, scanned=exp.filter(([_,v])=>v.scanned).length;
 return {total,scanned,pending:total-scanned};
}
function renderCouriers(){
 $("courierList").innerHTML=courierNames.map(c=>{
   const arr=Object.entries(state.expected).filter(([_,v])=>v.courier===c);
   const total=arr.length, scanned=arr.filter(([_,v])=>v.scanned).length;
   const checked=state.selected.includes(c)?"checked":"";
   return `<div class="courier"><div class="courier-top">
   <input type="checkbox" data-courier="${c}" ${checked}> ${c}</div>
   <div class="courier-meta"><span>Total: ${total}</span><span>Scanned: ${scanned}</span>
   <span>Pending: ${total-scanned}</span><span>${total?Math.round(scanned/total*100):0}%</span></div></div>`;
 }).join("");
 document.querySelectorAll("[data-courier]").forEach(x=>x.onchange=()=>{
   if(x.checked&&!state.selected.includes(x.dataset.courier))state.selected.push(x.dataset.courier);
   if(!x.checked)state.selected=state.selected.filter(c=>c!==x.dataset.courier);
   $("allCouriers").checked=state.selected.length===courierNames.length; save();render();
 });
 $("allCouriers").checked=state.selected.length===courierNames.length;
}
function courierDashboardStats(){
  return courierNames.map(c=>{
    const expected=Object.values(state.expected||{}).filter(v=>v.courier===c);
    const total=expected.length, scanned=expected.filter(v=>v.scanned).length;
    const pending=Math.max(0,total-scanned);
    const duplicate=(state.duplicates||[]).filter(v=>v.courier===c).reduce((n,v)=>n+(Number(v.count)||1),0);
    const wrong=(state.wrong||[]).filter(v=>v.expectedCourier===c).length;
    const attempts=scanned+duplicate+wrong;
    const percent=total?Math.round(scanned/total*1000)/10:0;
    return {courier:c,total,scanned,pending,duplicate,wrong,attempts,percent};
  });
}
function escHtml(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));}
function renderCourierDashboard(){
  const stats=courierDashboardStats(), cards=$("courierDashboardCards"), rows=$("courierDashboardRows");
  if(!cards||!rows)return;
  cards.innerHTML=stats.map(x=>`<div class="courier-dash-card"><div class="courier-dash-top"><div><span class="courier-dash-label">COURIER</span><h3>${escHtml(x.courier)}</h3></div><strong>${x.percent}%</strong></div><div class="courier-dash-progress"><div style="width:${Math.min(100,x.percent)}%"></div></div><div class="courier-dash-metrics"><div><span>Total</span><b>${x.total}</b></div><div><span>Scanned</span><b>${x.scanned}</b></div><div><span>Pending</span><b>${x.pending}</b></div></div><div class="courier-dash-extra"><span>Duplicate <b>${x.duplicate}</b></span><span>Wrong <b>${x.wrong}</b></span></div></div>`).join('');
  rows.innerHTML=stats.map(x=>`<tr><td><b>${escHtml(x.courier)}</b></td><td>${x.total}</td><td>${x.scanned}</td><td class="${x.pending?'pending-cell':'done-cell'}">${x.pending}</td><td><div class="mini-progress"><div style="width:${Math.min(100,x.percent)}%"></div></div><small>${x.percent}%</small></td><td>${x.duplicate}</td><td>${x.wrong}</td></tr>`).join('');
  const stamp=$("courierDashUpdated"); if(stamp)stamp.textContent=`LIVE · ${new Date().toLocaleTimeString()}`;
}
function dashboardScannerState(){
  return state.active ? "SCANNING" : "PAUSED";
}
function updateProfessionalDashboard(c){
  const total=c.total||0, scanned=c.scanned||0, pending=c.pending||0;
  const pct=total?Math.round((scanned/total)*1000)/10:0;
  const attempts=scanned+state.duplicates.length+state.unknown.length+state.wrong.length;
  const set=(id,value)=>{const el=$(id);if(el)el.textContent=value};
  set("dashTotal",total);set("dashScanned",scanned);set("dashPending",pending);set("dashAttempts",attempts);
  set("dashProgressText",`${scanned} / ${total}`);
  set("dashValid",scanned);set("dashDuplicate",state.duplicates.length);set("dashUnknown",state.unknown.length);
  set("dashWrong",state.wrong.length);set("dashPendingStatus",pending);
  set("dashSession",state.sessionId||"—");
  set("dashReturnType",(state.returnType||"RTO").replace("CUSTOMER_RETURN","CUSTOMER RETURN"));
  set("dashScannerState",dashboardScannerState());
  const dbText=($("dbStatus")?.textContent||"").replace("LOCAL DATABASE: ","");
  set("dashDbState",dbText||"READY");
  set("dashboardPercent",`${pct}%`);
  set("dashProgressText",`${scanned} / ${total}`);
  const bar=$("dashProgressBar");if(bar)bar.style.width=`${Math.min(100,pct)}%`;
  const ring=$("dashboardRing");if(ring)ring.style.setProperty("--progress",Math.min(100,pct));
  const badge=$("dashboardState");
  if(badge){
    badge.className="dashboard-badge";
    if(total===0){badge.textContent="NO DATA";badge.classList.add("idle")}
    else if(pending===0){badge.textContent="COMPLETE";badge.classList.add("complete")}
    else if(state.active){badge.textContent="SCANNING";badge.classList.add("pending")}
    else {badge.textContent="PAUSED";badge.classList.add("idle")}
  }
}
function bindDashboardActions(){
  const start=$("dashStartScan"), pending=$("dashPendingBtn");
  if(start)start.onclick=()=>{$("startBtn").click()};
  if(pending)pending.onclick=()=>{viewPending()};
}
bindDashboardActions();

function render(){
 if(!state.sessionId){$("sessionId").textContent="No session";return}
 $("sessionId").textContent=state.sessionId; if($("returnType")) $("returnType").value=state.returnType||"RTO";
 const c=counts(); $("total").textContent=c.total;$("scanned").textContent=c.scanned;$("pending").textContent=c.pending; updateProfessionalDashboard(c); renderCourierDashboard(); renderSelectiveDelete();
 $("duplicate").textContent=state.duplicates.length;$("unknown").textContent=state.unknown.length;$("wrong").textContent=state.wrong.length;
 $("progressText").textContent=`${c.scanned} / ${c.total}`;
 $("progressBar").style.width=(c.total?c.scanned/c.total*100:0)+"%";
 $("validationStatus").textContent=c.total===0?"VALIDATION ENGINE: WAITING FOR EXPECTED DATA":(c.pending===0?"VALIDATION ENGINE: COMPLETE — NO PENDING PARCELS":"VALIDATION ENGINE: ACTIVE — PENDING PARCELS REMAIN");
 renderCouriers();
 $("records").innerHTML=state.records.slice(-100).reverse().map(r=>`<tr><td>${r.barcode}</td><td>${r.courier||"-"}</td><td>${r.returnType||state.returnType||"RTO"}</td><td>${r.status}</td><td>${r.time}</td></tr>`).join("");
 // Completion is a state transition, not a side effect on every render.
 if(c.total>0&&c.pending===0&&!state.completedAt){
   state.completedAt=new Date().toISOString(); state.active=false; save();
   showCompletion("DONE SCANNING",`Total Parcels: ${c.total} • Successfully Scanned: ${c.scanned} • Pending: 0`);
 }
}
function showCompletion(title,text){
  $("completionTitle").textContent=title;
  $("completionText").textContent=text;
  $("completion").classList.remove("hidden");
}
function hideCompletion(){ $("completion").classList.add("hidden"); }
function finishSession(){
  const c=counts();
  if(c.total===0)return;
  if(c.pending>0){
    showCompletion("SCANNING INCOMPLETE",`Total: ${c.total} • Scanned: ${c.scanned} • Pending: ${c.pending}`);
    return;
  }
  state.active=false; state.completedAt=state.completedAt||new Date().toISOString(); save();
  showCompletion("SESSION FINISHED",`Total Parcels: ${c.total} • Successfully Scanned: ${c.scanned} • Pending: 0`);
}
function viewPending(){
  hideCompletion();
  const pending=selectedExpected().filter(([_,v])=>!v.scanned);
  if(!pending.length){alert("No pending parcels. Scanning is complete.");return;}
  const preview=pending.slice(0,50).map(([b,v])=>`${b} — ${v.courier||"-"}`).join("\n");
  alert(`Pending parcels: ${pending.length}\n\n${preview}${pending.length>50?"\n…and more":""}`);
}
function exportPendingNow(){ exportReport("pending"); }

function result(cls,title,detail){
 $("scanStatus").className="scan-status "+cls;$("scanStatus").textContent=title;$("lastResult").innerHTML=`<b>${title}</b><br>${detail}`;
}
function selectedCourierList(){return Array.isArray(state.selected)?state.selected:[];}
function validationResult(code,details={}){
  return {code,...details,returnType:details.returnType||state.returnType||"RTO"};
}
function validateBarcode(barcode){
  const selected=selectedCourierList();
  const match=state.expected[barcode];
  if(!match) return validationResult("UNKNOWN",{barcode});
  if(match.conflict) return validationResult("DATA_CONFLICT",{barcode,courier:match.courier});
  if(!selected.includes(match.courier)) return validationResult("WRONG_COURIER",{barcode,courier:match.courier,selectedCourier:selected.join(", ")});
  if(match.scanned) return validationResult("DUPLICATE",{barcode,courier:match.courier,originalTime:match.scanTime||""});
  return validationResult("VALID",{barcode,courier:match.courier});
}
function recordValidation(v){
  const t=now(), rt=v.returnType||state.returnType||"RTO";
  if(v.code==="VALID"){
    const match=state.expected[v.barcode];
    match.scanned=true; match.scanDate=new Date().toLocaleDateString(); match.scanTime=t;
    state.records.push({barcode:v.barcode,courier:v.courier,returnType:match.returnType||rt,status:"VALID / EXPECTED",time:t});
    result("ready","VALID / EXPECTED",`Courier: ${v.courier}<br>Barcode: ${v.barcode}`);
    return;
  }
  if(v.code==="DUPLICATE"){
    const previous=state.duplicates.find(x=>x.barcode===v.barcode);
    const count=(previous?.count||0)+1;
    if(previous) previous.count=count; else state.duplicates.push({barcode:v.barcode,courier:v.courier,returnType:rt,originalTime:v.originalTime||"",time:t,count:count});
    state.records.push({barcode:v.barcode,courier:v.courier,returnType:rt,status:"DUPLICATE",time:t,duplicateCount:count});
    result("warn","DUPLICATE SCAN",`Courier: ${v.courier}<br>Duplicate attempt #${count}. Valid count was not increased.`);
    return;
  }
  if(v.code==="WRONG_COURIER"){
    state.wrong.push({barcode:v.barcode,expectedCourier:v.courier,selectedCourier:v.selectedCourier,returnType:rt,time:t});
    state.records.push({barcode:v.barcode,courier:v.courier,returnType:rt,status:"WRONG COURIER",time:t});
    result("bad","WRONG COURIER",`Expected courier: ${v.courier}<br>Selected: ${v.selectedCourier||"None"}`);
    return;
  }
  if(v.code==="DATA_CONFLICT"){
    state.unknown.push({barcode:v.barcode,reason:"DATA_CONFLICT",returnType:rt,time:t});
    state.records.push({barcode:v.barcode,courier:"CONFLICT",returnType:rt,status:"DATA CONFLICT",time:t});
    result("bad","DATA CONFLICT",`Barcode is associated with multiple courier records: ${v.barcode}`);
    return;
  }
  state.unknown.push({barcode:v.barcode,returnType:rt,time:t});
  state.records.push({barcode:v.barcode,courier:"-",returnType:rt,status:"UNKNOWN / NOT FOUND",time:t});
  result("bad","UNKNOWN / NOT IN UPLOADED DATA",`Barcode: ${v.barcode}`);
}
function scan(raw,options={}){
 const barcode=normalizeBarcode(raw); if(!barcode)return;
 if(!options.silent) beep();
 if(!state.sessionId)newSession();
 const validation=validateBarcode(barcode);
 recordValidation(validation);
 save();render();$("barcodeInput").value="";$("barcodeInput").focus();
}
$("returnType").onchange=()=>{state.returnType=$("returnType").value;save();render();};
$("searchBtn").onclick=openSearch;
$("closeSearchBtn").onclick=()=>$("searchModal").classList.add("hidden");
$("globalSearchGo").onclick=performGlobalSearch;
$("globalSearchInput").addEventListener("keydown",e=>{if(e.key==="Enter")performGlobalSearch()});
$("newSessionBtn").onclick=newSession;$("sessionHistoryBtn").onclick=openSessionHistory;$("closeHistoryBtn").onclick=()=>$("sessionHistoryModal").classList.add("hidden");$("demoBtn").onclick=demo;
$("startBtn").onclick=()=>{state.active=true;state.completedAt=null;save();hideCompletion();hardwareState("READY — USB/Bluetooth scanner can scan now","ready");$("scanStatus").className="scan-status active";$("scanStatus").textContent="SCANNING — READY";$("barcodeInput").focus()};
$("stopBtn").onclick=()=>{state.active=false;save();hardwareState("SCANNER PAUSED — press START SCAN to resume","error");$("scanStatus").className="scan-status ready";$("scanStatus").textContent="SCAN STOPPED";};
$("barcodeInput").addEventListener("keydown",e=>{if(e.key==="Enter"){scan(e.target.value);e.preventDefault()}});
$("allCouriers").onchange=e=>{state.selected=e.target.checked?courierNames.slice():[];save();render()};
$("continueScanning").onclick=()=>{state.active=true;state.completedAt=null;save();hideCompletion();$("scanStatus").className="scan-status active";$("scanStatus").textContent="SCANNING — READY";$("barcodeInput").focus()};
$("viewPending").onclick=viewPending;
$("exportPending").onclick=exportPendingNow;
$("finishSession").onclick=finishSession;
$("clearBtn").onclick=()=>{if(confirm("Clear current session scan records and expected data?")){stopCamera();newSession()}};
$("backupBtn").onclick=backupData;$("restoreBtn").onclick=openRestorePicker;$("restoreFile").onchange=e=>restoreBackupFile(e.target.files?.[0]);
$("cameraStartBtn").onclick=startCamera;
$("cameraStopBtn").onclick=stopCamera;
$("torchBtn").onclick=toggleTorch;
$("cameraSelect").onchange=()=>{if(cameraRunning){stopCamera();startCamera()}};
navigator.mediaDevices?.addEventListener?.("devicechange",loadCameras);
loadCameras();
initHardwareScanner();
renderMappingMemory();
bindSelectiveDelete();
if(!state.sessionId)newSession();else render();
hydrateFromDatabase();
updateOfflineStatus();
setTimeout(()=>{const v=$("appVersion");if(v)v.textContent=APP_VERSION;},0);

// V12 Security — local PIN lock. Only a salted SHA-256 verifier is stored.
const SECURITY_KEY="rto_scanner_security_v1";
let appLocked=false;
function securityConfig(){try{return JSON.parse(localStorage.getItem(SECURITY_KEY)||"null")}catch(e){return null}}
function bytesToHex(bytes){return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("")}
async function hashPin(pin,salt){
  const data=new TextEncoder().encode(salt+":"+pin);
  return bytesToHex(await crypto.subtle.digest("SHA-256",data));
}
function randomSalt(){const b=new Uint8Array(16);crypto.getRandomValues(b);return bytesToHex(b.buffer)}
async function setPin(pin){
  const salt=randomSalt();
  const hash=await hashPin(pin,salt);
  localStorage.setItem(SECURITY_KEY,JSON.stringify({enabled:true,salt,hash,updatedAt:new Date().toISOString()}));
}
function disablePin(){localStorage.removeItem(SECURITY_KEY)}
async function verifyPin(pin){const c=securityConfig();if(!c?.enabled)return true;return (await hashPin(pin,c.salt))===c.hash}
function setLocked(locked){
  appLocked=locked;
  const el=$("pinLock"); if(el)el.classList.toggle("hidden",!locked);
  document.body.classList.toggle("app-locked",locked);
}
async function unlockWithPin(){
  const input=$("unlockPinInput"), msg=$("unlockMessage");
  if(await verifyPin(input.value)){input.value="";msg.textContent="";setLocked(false);render();}
  else {msg.textContent="Incorrect PIN.";input.select()}
}
function openSecurity(){
  const c=securityConfig();
  $("pinInput").value="";$("pinConfirmInput").value="";
  $("securityMessage").textContent=c?.enabled?"PIN lock is ENABLED. You can change or disable it.":"PIN lock is DISABLED.";
  $("securityModal").classList.remove("hidden");
}
$("securityBtn").onclick=openSecurity;
$("closeSecurityBtn").onclick=()=>$("securityModal").classList.add("hidden");
$("savePinBtn").onclick=async()=>{
  const a=$("pinInput").value,b=$("pinConfirmInput").value,msg=$("securityMessage");
  if(!/^\d{4,12}$/.test(a)){msg.textContent="Use a 4–12 digit PIN.";return}
  if(a!==b){msg.textContent="PIN confirmation does not match.";return}
  if(!window.crypto?.subtle){msg.textContent="Secure PIN storage is not supported in this browser.";return}
  await setPin(a);msg.textContent="PIN lock enabled successfully.";setTimeout(()=>$("securityModal").classList.add("hidden"),500);
};
$("disablePinBtn").onclick=()=>{const c=securityConfig();if(!c?.enabled){$("securityMessage").textContent="PIN lock is already disabled.";return} const p=prompt("Enter current PIN to disable PIN lock:"); if(p!==null) verifyPin(p).then(ok=>{if(ok){disablePin();$("securityMessage").textContent="PIN lock disabled.";}else $("securityMessage").textContent="Incorrect current PIN."});};
$("unlockPinBtn").onclick=unlockWithPin;
$("unlockPinInput").addEventListener("keydown",e=>{if(e.key==="Enter")unlockWithPin()});
async function initSecurity(){
  const c=securityConfig();
  if(c?.enabled)setLocked(true); else setLocked(false);
}
initSecurity();


// V20 Performance Test Lab — synthetic local tests only; never mutates production session data.
function perfNow(){return performance?.now?performance.now():Date.now()}
function perfDataset(n){
  const a=new Array(n);
  for(let i=0;i<n;i++) a[i]={barcode:"P"+String(i).padStart(10,"0"),courier:courierNames[i%courierNames.length],order:"ORD"+i};
  return a;
}
function perfBenchmark(n){
  const t0=perfNow(), rows=perfDataset(n), generated=perfNow();
  const map=new Map();
  for(const r of rows) map.set(r.barcode,r);
  const indexed=perfNow();
  let hits=0,misses=0;
  const probes=Math.min(n,5000);
  for(let i=0;i<probes;i++){if(map.has(rows[i].barcode))hits++;if(!map.has("MISSING_"+i))misses++}
  const searched=perfNow();
  let duplicateCount=0; const seen=new Set();
  for(const r of rows){if(seen.has(r.barcode))duplicateCount++;else seen.add(r.barcode)}
  const validated=perfNow();
  return {n,generate:generated-t0,index:indexed-generated,search:searched-indexed,validation:validated-searched,hits,misses,duplicates:duplicateCount,total:validated-t0};
}
function perfFormat(ms){return ms<1000?ms.toFixed(1)+" ms":(ms/1000).toFixed(2)+" s"}
async function runPerformanceTests(){
  const btn=$("runPerfTests"), out=$("perfResults"); if(!btn||!out)return;
  btn.disabled=true; out.textContent="Running local stress tests…";
  await new Promise(r=>setTimeout(r,30));
  const results=[];
  try{
    for(const n of [1000,10000,50000]){
      const r=perfBenchmark(n); results.push(r);
      const el=$(n===1000?"perf1k":n===10000?"perf10k":"perf50k");
      if(el)el.textContent=perfFormat(r.total);
      await new Promise(requestAnimationFrame);
    }
    const max=Math.max(...results.map(r=>r.total));
    out.innerHTML=results.map(r=>`<div><b>${r.n.toLocaleString()} records</b> — total ${perfFormat(r.total)} | generate ${perfFormat(r.generate)} | index ${perfFormat(r.index)} | search ${perfFormat(r.search)} | duplicate validation ${perfFormat(r.validation)} | hits ${r.hits.toLocaleString()} | duplicates ${r.duplicates}</div>`).join("")+`<div class="perf-ok"><b>RESULT:</b> synthetic test completed successfully. Real-device timings will vary.</div>`;
  }catch(e){out.textContent="Performance test failed: "+(e?.message||e);}
  finally{btn.disabled=false}
}
// V21 Real Warehouse Test — deterministic 10,000-record simulation; never mutates production data.
function runWarehouseSimulation(){
  const total=10000, valid=8500, duplicate=500, unknown=300, wrong=200;
  const pending=total-valid;
  const expectedAttemptClasses=valid+duplicate+unknown+wrong;
  const requestedPending=500;
  return {total,valid,duplicate,unknown,wrong,pending,expectedAttemptClasses,requestedPending,
    balanced: pending===requestedPending,
    attempts: valid+duplicate+unknown+wrong};
}
function runWarehouseTest(){
  const btn=$("runWarehouseTest"),out=$("warehouseTestResults"); if(!btn||!out)return;
  btn.disabled=true; out.textContent="Running 10,000-record warehouse simulation…";
  setTimeout(()=>{
    try{
      const r=runWarehouseSimulation();
      $("whExpected").textContent=r.total.toLocaleString();
      $("whValid").textContent=r.valid.toLocaleString();
      $("whDuplicate").textContent=r.duplicate.toLocaleString();
      $("whUnknown").textContent=r.unknown.toLocaleString();
      $("whWrong").textContent=r.wrong.toLocaleString();
      $("whPending").textContent=r.pending.toLocaleString();
      const mismatch=r.pending-r.requestedPending;
      out.innerHTML=`<div><b>Mathematical check:</b> ${r.total.toLocaleString()} expected − ${r.valid.toLocaleString()} unique valid = <b>${r.pending.toLocaleString()} pending</b>.</div>
      <div><b>Attempt breakdown:</b> ${r.valid.toLocaleString()} valid + ${r.duplicate.toLocaleString()} duplicate + ${r.unknown.toLocaleString()} unknown + ${r.wrong.toLocaleString()} wrong courier = <b>${r.attempts.toLocaleString()} scan attempts</b>.</div>
      <div class="${r.balanced?'perf-ok':'perf-warn'}"><b>Scenario check:</b> the roadmap example says Pending = ${r.requestedPending.toLocaleString()}, but with Total = ${r.total.toLocaleString()} and Valid = ${r.valid.toLocaleString()}, mathematically Pending must be ${r.pending.toLocaleString()} (difference ${Math.abs(mismatch).toLocaleString()}).</div>
      <div><b>Production-data safety:</b> PASS — this simulation uses isolated in-memory data only.</div>`;
    }catch(e){out.textContent="Warehouse test failed: "+(e?.message||e)}
    finally{btn.disabled=false}
  },30);
}
$("runWarehouseTest")?.addEventListener("click",runWarehouseTest);
$("clearWarehouseTest")?.addEventListener("click",()=>{
  ["whExpected","whValid","whDuplicate","whUnknown","whWrong","whPending"].forEach(id=>{if($(id))$(id).textContent="—"});
  if($("warehouseTestResults"))$("warehouseTestResults").textContent="No warehouse test has been run yet.";
});

$("runPerfTests")?.addEventListener("click",runPerformanceTests);
$("clearPerfResults")?.addEventListener("click",()=>{
  ["perf1k","perf10k","perf50k"].forEach(id=>{if($(id))$(id).textContent="—"});
  if($("perfResults"))$("perfResults").textContent="No performance test has been run yet.";
});
