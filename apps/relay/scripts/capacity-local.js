// Local-only real Classroom clients. Credentials stay in memory/anonymous pipes.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import WebSocket from "ws";
const incoming=createInterface({input:process.stdin});
let configure;const initial=new Promise(r=>configure=r), controls=new Map();
incoming.on("line",line=>{const value=JSON.parse(line);if(value.controlId){controls.get(value.controlId)?.(value.result);controls.delete(value.controlId);}else configure(value);});
const config=await initial;
const origin=new URL(config.origin);
if(origin.protocol!=="http:"||!["127.0.0.1","localhost"].includes(origin.hostname))throw new Error("Local-only harness");
if(!Number.isInteger(config.students)||config.students<1||config.students>40)throw new Error("Invalid bounded client count");
const target=path.resolve("apps/teacher/src-tauri/target");
const output=path.resolve(config.outputPath);
if(!output.startsWith(target+path.sep))throw new Error("Report must stay in ignored target");
const started=performance.now();
const hardStop=setTimeout(()=>{process.stderr.write("Capacity wall-clock limit reached\n");process.exit(2);},29*60*1000);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const control=name=>requestControl(name);
function requestControl(name,extra={}) {const controlId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{controls.delete(controlId);reject(new Error("Harness control deadline"));},45000);controls.set(controlId,value=>{clearTimeout(timer);resolve(value);});console.log(JSON.stringify({control:name,controlId,...extra}));});}
let plannedReconnect=false;
const observations=[], counters={http:0,studentWsFrames:0,studentWsUtf8Bytes:0,receivedFrames:0,offline:0,unexpectedOffline:0,reauth:0,auth:0,sync:0,pongs:0,wsErrors:0};
const statuses=new Map();const fetchNative=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input),origin);if(url.origin!==origin.origin)throw new Error("Cross-origin harness target forbidden");
 counters.http++;
 const response=await fetchNative(url,{...init,redirect:"error"});
 const headers=new Headers(init?.headers);const key=headers.get("x-classroom-participant")+":"+url.pathname;
 const list=statuses.get(key)??[];list.push(response.status);statuses.set(key,list);
 return response;
};
const {studentHttpRead}=await import(pathToFileURL(config.clientModule).href);
function record(value){observations.push(value);console.log(JSON.stringify({measurement:value}));}
async function waitFor(predicate,ms=15000){const start=performance.now();while(!predicate()){if(performance.now()-start>ms)throw new Error("Bounded wait expired");await delay(20);}}
const clients=[];
const transportEvents=[];
function trace(event,client,extra={}){if(transportEvents.length<1024)transportEvents.push({atMs:performance.now()-started,event,client,...extra});}
class Student {
 constructor(index,participant){this.index=index;this.p=participant;this.pending=new Map();this.pingTimes=new Map();this.pingMs=[];this.ready=false;this.synced=false;this.auths=0;this.syncs=0;this.errors=[];this.questionStates=new Map();this.reveals=new Set();}
 send(type,message){const raw=JSON.stringify({v:1,type,id:randomUUID(),payload:{message}});if(Buffer.byteLength(raw)>65536)throw new Error("Envelope ceiling");counters.studentWsFrames++;counters.studentWsUtf8Bytes+=Buffer.byteLength(raw);this.socket.send(raw);}
 auth(){this.ready=false;this.synced=false;this.send("AUTH",{protocolVersion:1,type:"participant_auth",requestId:randomUUID(),sessionId:this.p.sessionId,participantId:this.p.participantId,credential:this.p.credential});}
 async open(){
  const url=new URL("/v1/sessions/"+config.remoteSessionId+"/ws",origin);url.protocol="ws:";
  this.socket=new WebSocket(url,{origin:origin.origin,maxPayload:65536});
  this.socket.on("error",()=>{counters.wsErrors++;this.ready=false;});
  this.socket.on("close",(code)=>{trace("close",this.index,{code});this.ready=false;});
  this.socket.on("message",raw=>{
   counters.receivedFrames++;const envelope=JSON.parse(raw.toString());const p=envelope.payload;
   if(envelope.type==="CONTROL"){if(p.op==="teacher_offline"){this.ready=false;this.synced=false;counters.offline++;if(!plannedReconnect)counters.unexpectedOffline++;}
    if(p.op==="REAUTH_REQUIRED"){trace("reauth",this.index,{generation:p.generation});counters.reauth++;this.auth();}return;}
   const message=p.message;
   if(envelope.type==="AUTH"){trace("auth_result",this.index,{accepted:p.accepted});if(p.accepted){this.ready=true;this.auths++;counters.auth++;}else this.errors.push(p.message?.code??"AUTH_FAILED");return;}
   if(envelope.type==="ERROR"){trace("error",this.index,{code:p.code});this.errors.push(p.code??"TRANSPORT_ERROR");return;}
   if(!message)return;
   if(message.type==="question_state_changed")this.questionStates.set(message.question.sessionQuestionId,message.question.state);
   if(message.type==="question_revealed")this.reveals.add(message.reveal.sessionQuestionId);
   if(message.type==="session_sync"){this.synced=true;this.syncs++;counters.sync++;}
   if(message.type==="pong"){const when=this.pingTimes.get(message.requestId);if(when!==undefined){this.pingMs.push(performance.now()-when);this.pingTimes.delete(message.requestId);counters.pongs++;}}
   if(message.type==="submission_acknowledged"){const ack=message.acknowledgement;const pending=this.pending.get(ack.submissionId);if(pending){pending.resolve({ms:performance.now()-pending.start,accepted:ack.accepted===true});this.pending.delete(ack.submissionId);}}
   if(message.type==="error")this.errors.push(message.code);
  });
  await new Promise((resolve,reject)=>{this.socket.once("open",resolve);this.socket.once("error",()=>reject(new Error("Student socket open failed")));});
  this.auth();await waitFor(()=>this.ready&&this.synced);
  this.timer=setInterval(()=>{if(this.ready&&this.synced){const requestId=randomUUID();this.pingTimes.set(requestId,performance.now());this.send("REALTIME",{protocolVersion:1,type:"ping",requestId});}},3000);
 }
 async submit(questionId){
  if(!this.ready||!this.synced)throw new Error("No mutation before AUTH/sync");
  trace("submit",this.index);
  const submissionId=randomUUID();const answer=new Promise(resolve=>this.pending.set(submissionId,{start:performance.now(),resolve}));
  this.send("REALTIME",{protocolVersion:1,type:"submit_answer",requestId:randomUUID(),submissionId,sessionQuestionId:questionId,answer:{type:"true_false",value:true}});
  return Promise.race([answer,delay(10000).then(()=>{if(this.pending.has(submissionId)){this.pending.delete(submissionId);return{ms:10000,accepted:false};}})]);
 }
 close(){clearInterval(this.timer);this.socket.close();}
}
function quantiles(values){if(!values.length)return{n:0};const sorted=[...values].sort((a,b)=>a-b);return{n:values.length,p50:sorted[Math.ceil(.50*sorted.length)-1],p95:sorted[Math.ceil(.95*sorted.length)-1],max:sorted.at(-1)};}
let details;let diagnosticLoopTimer;let diagnosticPresenceTimer;
async function read(client,asset="image",cancel=false,onFirstByte){
 const isMedia=asset!=="detail";const operation=isMedia?"SESSION_ASSET_GET":"PEER_REVIEW_ACTIVITY_GET";
 const request=isMedia?{operation,arguments:{assetId:asset==="pdf"?details.pdfId:details.imageId}}:{operation,arguments:{activityId:details.activityId}};
 const key=client.p.participantId+":/v1/sessions/"+config.remoteSessionId+"/http/"+operation;
 const attemptStart=(statuses.get(key)??[]).length;
 const clock=performance.now();const abort=new AbortController();
 let response;
 try{response=await studentHttpRead(client.p,request,abort.signal);}catch{return{client:client.index,status:"FETCH_ERROR",totalMs:performance.now()-clock};}
 const headersMs=performance.now()-clock;
 if(!response.ok){const body=await response.json();return{client:client.index,status:response.status,code:body.code,totalMs:performance.now()-clock,attempts:(statuses.get(key)??[]).slice(attemptStart)};}
 const hash=createHash("sha256");let bytes=0,firstByteMs=null;
 const reader=response.body.getReader();
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;if(firstByteMs===null){firstByteMs=performance.now()-clock;onFirstByte?.();}bytes+=value.length;hash.update(value);
   if(cancel){abort.abort();await reader.cancel().catch(()=>{});return{client:client.index,status:"CANCELLED",bytes,totalMs:performance.now()-clock};}
  }
 }catch{return{client:client.index,status:"INTERRUPTED",bytes,totalMs:performance.now()-clock};}
 const totalMs=performance.now()-clock;
 if(isMedia && response.headers.get("content-type")!==(asset==="pdf"?"application/pdf":"image/png"))throw new Error("Media MIME violation");
 const hashOk=!isMedia||hash.digest("hex")===(asset==="pdf"?config.pdfHash:config.imageHash);
 if(!hashOk)throw new Error("Media integrity violation");
 return{client:client.index,status:200,bytes,headersMs,firstByteMs,totalMs,bodyMs:totalMs-headersMs,hashOk,
  mime:response.headers.get("content-type"),attempts:(statuses.get(key)??[]).slice(attemptStart)};
}
async function sample(label,n){const before=await control("metrics");const began=performance.now();const media=Promise.all(clients.slice(0,n).map(c=>read(c)));await delay(50);const acks=await Promise.all(clients.map(c=>c.submit(details.questionId)));const rows=await media;const after=await control("metrics");
 record({label,n,rows,rawAcks:acks,ack:quantiles(acks.map(a=>a.ms)),firstAttemptSuccess:rows.filter(r=>r.attempts?.[0]===200).length,eventualSuccess:rows.filter(r=>r.status===200).length,wallMs:performance.now()-began,nativeBefore:before,nativeAfter:after});
 return rows;
}
execution: try{
 for(let index=0;index<config.students;index++){
  const response=await fetch(new URL("/v1/sessions/"+config.remoteSessionId+"/join",origin),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({remoteProtocolVersion:1,joinAttemptId:randomUUID(),seatNumber:index+1,name:"Fixture "+(index+1)})});
  if(response.status!==200)throw new Error("Synthetic LOBBY join failed");
  const joined=await response.json();const student=new Student(index+1,joined.participant);await student.open();clients.push(student);
 }
 details=await requestControl("start",{participantIds:clients.map(c=>c.p.participantId)});
 await delay(100);
 record({label:"thresholds",textAckP95Ms:2000,mediaAckP95Ms:3000,image95PercentMs:30000,imageAllMs:60000,algorithm:"nearest-rank ceil(p*n)-1; monotonic per process",clientPolicy:"actual bundled studentHttpRead",network:"same Windows PC, loopback; not mobile render"});

 if(config.mode==="a2-recovery"){
  let firstByte;const first=new Promise(resolve=>firstByte=resolve);
  const interrupted=read(clients[0],"pdf",false,firstByte);
  await Promise.race([first,delay(10000).then(()=>{throw new Error("First-byte deadline");})]);
  const oldSync=clients.map(c=>c.syncs),began=performance.now();plannedReconnect=true;
  await control("reconnect");await waitFor(()=>clients.every((c,i)=>c.ready&&c.synced&&c.syncs>oldSync[i]),30000);
  const recoveryMs=performance.now()-began;plannedReconnect=false;
  const interruption=await interrupted;
  const rawAcks=await Promise.all(clients.map(c=>c.submit(details.questionId)));
  const image=await read(clients[0]);
  const canceled=await read(clients[1],"pdf",true);await delay(300);
  const replacement=await read(clients[1]);await delay(300);
  const native=await control("metrics"),presence=await control("presence"),progress=(await control("progress")).answeredCount;
  const ok=interruption.status==="INTERRUPTED"&&rawAcks.every(a=>a.accepted)&&quantiles(rawAcks.map(a=>a.ms)).p95<=2000&&progress===clients.length&&image.status===200&&canceled.status==="CANCELLED"&&replacement.status===200&&native.activeReaders===0&&native.activeMedia===0&&native.creditWaiters===0&&!native.budgetStopped&&presence.online===clients.length&&counters.unexpectedOffline===0&&counters.wsErrors===0&&clients.every(c=>c.ready&&c.synced&&c.errors.length===0);
  record({label:"A2_generation_cancel",interruption,recoveryMs,rawAcks,ack:quantiles(rawAcks.map(a=>a.ms)),progress,image,canceled,replacement,presence,native,counters,transportEvents,status:ok?"PASS":"FAIL_BLOCKER"});
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({observations},null,2));console.log(JSON.stringify({done:true,report:"ignored target output"}));process.exitCode=ok?0:1;break execution;
 }
 if(["stream-probe","stream-probe-four"].includes(config.mode)){
  const streams=config.mode==="stream-probe-four"?4:1;
  if(clients.length<streams)throw new Error("Not enough bounded clients");
  const lag=[];let lastTick=performance.now();
  diagnosticLoopTimer=setInterval(()=>{const now=performance.now();lag.push(Math.max(0,now-lastTick-100));lastTick=now;},100);
  const presenceSamples=[];let presenceBusy=false;
  const samplePresence=async()=>{if(presenceBusy||presenceSamples.length>=256)return;presenceBusy=true;try{presenceSamples.push({atMs:performance.now()-started,...await control("presence")});}catch{presenceSamples.push({atMs:performance.now()-started,error:"presence_control_failed"});}finally{presenceBusy=false;}};
  await samplePresence();diagnosticPresenceTimer=setInterval(()=>{void samplePresence();},1000);
  let completedPdfs=0;
  const first=[];const pdfs=Promise.all(clients.slice(0,streams).map(c=>{let signal;first.push(new Promise(resolve=>signal=resolve));return read(c,"pdf",false,signal).then(row=>{completedPdfs++;return row;});}));
  await Promise.race([Promise.all(first),delay(10000).then(()=>{throw new Error("First-byte deadline");})]);
  const during=performance.now();
  const rawAcks=await Promise.all(clients.map(c=>c.submit(details.questionId)));
  const detail=await read(clients.at(-1),"detail");
  let lockReveal={status:"NOT_RUN",reason:"earlier ACK gate"};
  if(rawAcks.every(a=>a.accepted)&&quantiles(rawAcks.map(a=>a.ms)).p95<=3000){
   const lockStart=performance.now(),activeAtLock=streams-completedPdfs;await control("lock");await waitFor(()=>clients.every(c=>c.questionStates.get(details.questionId)==="LOCKED"),3000);const lockMs=performance.now()-lockStart;
   const revealStart=performance.now(),activeAtReveal=streams-completedPdfs;await control("reveal");await waitFor(()=>clients.every(c=>c.reveals.has(details.questionId)),3000);
   lockReveal={status:"PASS",clients:clients.length,lockMs,revealMs:performance.now()-revealStart,activeAtLock,activeAtReveal};
  }
  const results=await pdfs;clearInterval(diagnosticLoopTimer);clearInterval(diagnosticPresenceTimer);await samplePresence();
  await delay(300);
  const progress=(await control("progress")).answeredCount;
  const ok=results.every(r=>r.status===200)&&rawAcks.every(a=>a.accepted)&&quantiles(rawAcks.map(a=>a.ms)).p95<=3000&&detail.status===200&&progress===clients.length&&lockReveal.status==="PASS"&&lockReveal.activeAtLock>0&&lockReveal.activeAtReveal>0&&counters.reauth===0&&counters.unexpectedOffline===0&&clients.every(c=>c.ready&&c.synced&&c.errors.length===0)&&presenceSamples.every(s=>s.online===clients.length);
  record({label:"C4_stream_probe",students:clients.length,streams,trigger:"after all active streams first body bytes",transportEvents,presenceSamples,lockReveal,pdfs:results,eventLoopDelay:quantiles(lag),rawAcks,ack:quantiles(rawAcks.map(a=>a.ms)),detail,progress,elapsedAfterFirstMs:performance.now()-during,pingLatency:quantiles(clients.flatMap(c=>c.pingMs)),counters,native:await control("metrics"),status:ok?"PASS":"FAIL_BLOCKER"});
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({observations},null,2));
  console.log(JSON.stringify({done:true,report:"ignored target output"}));process.exitCode=ok?0:1;
  break execution;
 }
 const singles=[];
 for(let i=0;i<3;i++){const ack=await clients[0].submit(details.questionId);const detail=await read(clients[0],"detail");const media=await read(clients[0]);singles.push({sample:i+1,ack,detail,media});}
 record({label:"C1",samples:singles,native:await control("metrics")});
 let mediaBlocker=false;
 for(const n of [1,4,5,10,20,40].filter(n=>n<=config.students)){
  if(config.mode==="probe"&&n>5)break;
  const rows=await sample("C2_C3_media",n);
  if(observations.at(-1).ack.p95>3000||observations.at(-1).rawAcks.some(a=>!a.accepted)||rows.some(r=>r.status!==200)||rows.some(r=>r.totalMs>60000)||rows.filter(r=>r.totalMs<=30000).length<Math.ceil(.95*n)){
   mediaBlocker=true;record({label:"media_escalation_stopped",atStudents:n,reason:"actual client policy failed ordinary-image / concurrent-ACK gate"});break;
  }
  await delay(200);
 }
 const acks=await Promise.all(clients.map(c=>c.submit(details.questionId)));
 record({label:"text_ack",students:clients.length,raw:acks,summary:quantiles(acks.map(a=>a.ms)),progress:(await control("progress")).answeredCount});
 if(config.mode!=="probe"&&config.mode!=="a2-images"&&!mediaBlocker){
  let singleReady;const singleFirst=new Promise(resolve=>singleReady=resolve);
  const pdf=read(clients[0],"pdf",false,singleReady);
  await Promise.race([singleFirst,delay(10000).then(()=>{throw new Error("First-byte deadline");})]);
  const mixedAcks=await Promise.all(clients.map(c=>c.submit(details.questionId)));
  const detailRows=await Promise.all(clients.slice(-3).map(c=>read(c,"detail")));
  record({label:"C4_single_pdf",pdf:await pdf,ack:quantiles(mixedAcks.map(a=>a.ms)),rawAcks:mixedAcks,detail:detailRows,native:await control("metrics")});
  if(observations.at(-1).pdf.status!==200||mixedAcks.some(a=>!a.accepted)||quantiles(mixedAcks.map(a=>a.ms)).p95>3000||detailRows.some(r=>r.status!==200))throw new Error("Single PDF gate failed; escalation stopped");
  if(!mediaBlocker&&config.students>=4&&process.env.CLASSROOM_CAPACITY_FOUR_PDFS==="1"){
   const ready=[];const pdfs=Promise.all(clients.slice(0,4).map(c=>{let signal;ready.push(new Promise(resolve=>signal=resolve));return read(c,"pdf",false,signal);}));
   await Promise.race([Promise.all(ready),delay(10000).then(()=>{throw new Error("First-byte deadline");})]);
   const rawAcks=await Promise.all(clients.map(c=>c.submit(details.questionId)));
   const detail=await Promise.all(clients.slice(-3).map(c=>read(c,"detail")));
   record({label:"C4_four_pdf",rows:await pdfs,rawAcks,ack:quantiles(rawAcks.map(a=>a.ms)),detail,native:await control("metrics")});
  }else record({label:"C4_four_pdf",status:"NOT_VERIFIED",reason:mediaBlocker?"earlier capacity blocker":"not requested / memory gate"});
  const four=observations.at(-1);if(four.rows&&(four.rows.some(r=>r.status!==200)||four.rawAcks.some(a=>!a.accepted)||four.ack.p95>3000||four.detail.some(r=>r.status!==200)))throw new Error("Four PDF gate failed; escalation stopped");
  record({label:"cancel",row:await read(clients[0],"pdf",true)});await delay(300);
  record({label:"after_cancel",row:await read(clients[0]),native:await control("metrics")});
  await control("lock_reveal");
  const soakStart=performance.now();let reconnected=false;let rounds=0;const soakReads=[];
  const soakBefore=await control("metrics");const countersBefore={...counters};
  while(performance.now()-soakStart<config.soakSeconds*1000){
   await delay(Math.min(15000,Math.max(0,config.soakSeconds*1000-(performance.now()-soakStart))));
   if(performance.now()-soakStart>=config.soakSeconds*1000)break;
   rounds++;
   if(!reconnected&&performance.now()-soakStart>=config.soakSeconds*500){
    const begin=performance.now(),oldSync=clients.map(c=>c.syncs);
    plannedReconnect=true;await control("reconnect");await waitFor(()=>clients.every((c,i)=>c.ready&&c.synced&&c.syncs>oldSync[i]),30000);
    record({label:"reconnect",clients:clients.length,totalMs:performance.now()-begin});reconnected=true;plannedReconnect=false;
   }
   soakReads.push(await read(clients[rounds%clients.length],"detail"));
   if(rounds%4===0)soakReads.push(await read(clients[rounds%clients.length],"image",true));
   if(rounds%4===1)soakReads.push(await read(clients[rounds%clients.length]));
   if(rounds%4===0)record({label:"soak_checkpoint",elapsedMs:performance.now()-soakStart,native:await control("metrics"),counters:{...counters},nodeMemory:process.memoryUsage()});
  }
  await delay(300);
  record({label:"C5_soak",seconds:(performance.now()-soakStart)/1000,clients:clients.length,rounds,reconnected,reads:soakReads,countersBefore,countersAfter:{...counters},nativeBefore:soakBefore,nativeAfter:await control("metrics")});
 }
 record({label:"final",nodeMemory:process.memoryUsage(),durationMs:performance.now()-started,counters,pingLatency:quantiles(clients.flatMap(c=>c.pingMs)),pendingPings:clients.reduce((n,c)=>n+c.pingTimes.size,0),errors:clients.map(c=>({client:c.index,codes:c.errors})),native:await control("metrics")});
 const gates=[];
 const gate=(name,pass)=>gates.push({name,status:pass?"PASS":"FAIL_BLOCKER"});
 const ackGate=(name,rows,limit)=>gate(name,rows.every(r=>r.accepted===true)&&quantiles(rows.map(r=>r.ms)).p95<=limit);
 ackGate("C1_text_ack",singles.map(r=>r.ack),2000);
 gate("C1_detail_media",singles.every(r=>r.detail.status===200&&r.media.status===200));
 for(const o of observations){
  if(o.label==="C2_C3_media"){gate("image_completion_"+o.n,o.eventualSuccess===o.n&&o.rows.every(r=>r.totalMs<=60000)&&o.rows.filter(r=>r.totalMs<=30000).length>=Math.ceil(.95*o.n));ackGate("media_ack_"+o.n,o.rawAcks,3000);}
  if(o.label==="text_ack"){ackGate("text_ack",o.raw,2000);gate("authoritative_answered",o.progress===clients.length);}
  if(o.label==="C4_single_pdf"){gate("single_pdf_integrity",o.pdf.status===200&&o.pdf.hashOk);ackGate("single_pdf_ack",o.rawAcks,3000);gate("single_pdf_detail",o.detail.every(r=>r.status===200));}
  if(o.label==="C4_four_pdf"&&o.rows){gate("four_pdf_integrity",o.rows.every(r=>r.status===200&&r.hashOk));ackGate("four_pdf_ack",o.rawAcks,3000);gate("four_pdf_detail",o.detail.every(r=>r.status===200));}
  if(o.label==="cancel")gate("cancel",o.row.status==="CANCELLED");
  if(o.label==="after_cancel")gate("after_cancel",o.row.status===200);
  if(o.label==="C5_soak")gate("soak",o.seconds>=config.soakSeconds&&o.reconnected&&o.reads.every(r=>r.status===200||r.status==="CANCELLED"));
 }
 const final=observations.at(-1);gate("liveness",counters.unexpectedOffline===0&&counters.wsErrors===0&&clients.every(c=>c.errors.length===0&&c.ready&&c.synced));
 gate("released_resources",final.native.activeReaders===0&&final.native.activeMedia===0&&final.native.creditWaiters===0&&!final.native.budgetStopped);
 record({label:"gates",gates,scope:"Protocol synthetic WSS clients; actual Student HTTP policy; not physical-device acceptance"});
 if(gates.some(g=>g.status!=="PASS"))process.exitCode=1;
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({observations},null,2));
 console.log(JSON.stringify({done:true,report:"ignored target output"}));
}catch{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({observations,aborted:true},null,2));console.log(JSON.stringify({done:false,error:"Bounded local capacity failed; inspect prior sanitized measurements"}));process.exitCode=1;}
finally{clearInterval(diagnosticLoopTimer);clearInterval(diagnosticPresenceTimer);for(const c of clients)c.close();clearTimeout(hardStop);incoming.close();setTimeout(()=>process.exit(process.exitCode??0),300);}
