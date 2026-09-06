import { useEffect, useState } from "react";
import type { PeerReviewActivity, PeerReviewDraft, PeerReviewMode, PeerReviewSetup } from "@classtools/validation";
import type { PeerReviewApi } from "../../services/peerReviewApi";

const modes: Record<PeerReviewMode,string> = { RANDOM_ONE_TO_ONE:"隨機互評", STUDENT_SELECT:"學生自行選擇", CROSS_GROUP:"跨組互評" };
const states = { DRAFT:"草稿", OPEN:"進行中", CLOSED:"已結束", CANCELLED:"已取消" };
const questionStates = { HIDDEN:"尚未開放", OPEN:"作答中", LOCKED:"已鎖定", REVEALED:"已公布" };
interface Form { question: string; mode: PeerReviewMode; capacity: string; unlimited: boolean; groupSet: string }
function formFor(context: PeerReviewSetup, a?: PeerReviewActivity, initial?: string): Form {
  return {question:a?.session_question_id ?? (context.questions.some(q=>q.id===initial) ? initial! : context.questions[0]?.id ?? ""), mode:a?.mode ?? "RANDOM_ONE_TO_ONE", capacity:String(a?.max_reviews_per_target ?? 1), unlimited:a?.mode === "STUDENT_SELECT" && a.max_reviews_per_target === null, groupSet:a?.session_group_set_id ?? context.group_sets[0]?.id ?? ""};
}
const unchanged = (a: Form | null,b: Form | null) => JSON.stringify(a) === JSON.stringify(b);
const confirmDiscard = () => window.confirm("尚有未儲存的變更，確定要放棄嗎？");

export function PeerReviewPage({api,sessionId,initialQuestionId,onBack,onDirtyChange}: {api: PeerReviewApi;sessionId:string;initialQuestionId?:string;onBack:()=>void;onDirtyChange?:(value:boolean)=>void}) {
  const [context,setContext]=useState<PeerReviewSetup|null>(null);
  const [selected,setSelected]=useState("");
  const [form,setForm]=useState<Form|null>(null);
  const [saved,setSaved]=useState<Form|null>(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const dirty=!unchanged(form,saved);
  const current=context?.activities.find(a=>a.id===selected);
  const canEdit=context?.session_state === "ACTIVE" && (!current || current.state === "DRAFT");
  function adopt(next: PeerReviewSetup,id: string) {
    const a=next.activities.find(a=>a.id===id);
    const nextForm=formFor(next,a,initialQuestionId);
    setContext(next);setSelected(a?.id ?? "");setForm(nextForm);setSaved(nextForm);
  }
  useEffect(()=>{
    let cancelled=false; setLoading(true);setError("");setContext(null);
    void api.getPeerReviewSetupContext(sessionId).then(next=>{
      if(cancelled)return;
      const existing=next.activities.find(a=>a.session_question_id===initialQuestionId && a.state==="OPEN") ?? next.activities.find(a=>a.session_question_id===initialQuestionId && a.state==="DRAFT") ?? next.activities.find(a=>a.state==="OPEN" || a.state==="DRAFT") ?? next.activities[0];
      adopt(next,existing?.id ?? "");
    }).catch(()=>{if(!cancelled)setError("無法載入互評設定，請重試。");}).finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true;};
  },[api,sessionId,initialQuestionId]);
  useEffect(()=>{onDirtyChange?.(dirty || busy); return ()=>onDirtyChange?.(false);},[dirty,busy,onDirtyChange]);
  useEffect(()=>{
    if(!dirty)return;
    const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
    window.addEventListener("beforeunload",beforeUnload);return ()=>window.removeEventListener("beforeunload",beforeUnload);
  },[dirty]);
  async function refresh() {
    if(dirty && !confirmDiscard())return;
    setBusy(true);setError("");
    try {adopt(await api.getPeerReviewSetupContext(sessionId),selected);}
    catch {setContext(null);setError("無法確認課堂狀態，請重試。");}
    finally {setBusy(false);}
  }
  async function mutate(operation:()=>Promise<PeerReviewActivity>) {
    setBusy(true);setError("");
    try {const result=await operation();adopt(await api.getPeerReviewSetupContext(sessionId),result.id);}
    catch(cause) {
      setError(cause instanceof Error ? cause.message : "互評操作未完成，請重新載入。");
      try {
        const next=await api.getPeerReviewSetupContext(sessionId);
        const latest=next.activities.find(a=>a.id===selected);
        if(next.session_state!=="ACTIVE" || (latest && latest.state!=="DRAFT")) adopt(next,selected);
        else setContext(next); // Preserve unsaved inputs when a save fails.
      } catch {setContext(null);}
    } finally {setBusy(false);}
  }
  const choose=(id:string)=>{if(!context || busy || (dirty && !confirmDiscard()))return;adopt(context,id);setError("");};
  const back=()=>{if(!busy)onBack();}; // App owns the shared navigation confirmation.
  if(loading)return <section className="state-card" role="status">正在載入互評設定…</section>;
  if(!context || !form)return <section className="state-card"><h2>同儕互評</h2><p role="alert">{error || "無法載入互評設定。"}</p><button type="button" onClick={()=>void refresh()} disabled={busy}>重試</button><button type="button" onClick={back}>返回即時測驗</button></section>;
  const question=context.questions.find(q=>q.id===form.question);
  const preflight=context.group_sets.find(g=>g.id===form.groupSet)?.questions.find(q=>q.session_question_id===form.question);
  let block="";
  if(context.session_state!=="ACTIVE")block="課堂已結束或尚未開始，互評設定僅供檢視。";
  else if(!question || !["LOCKED","REVEALED"].includes(question.state))block="請先停止學生作答，再開放互評。";
  else if(form.mode==="CROSS_GROUP" && !form.groupSet)block="請選擇分組版本。";
  else if(form.mode==="CROSS_GROUP" && (preflight?.eligible_group_count ?? 0)<2)block="至少需要 2 個具有論述答案的組別。";
  else if(form.mode!=="CROSS_GROUP" && question.eligible_participant_count<2)block="至少需要 2 位已提交論述答案的學生。";
  const capacity=Number(form.capacity);
  const validCapacity=form.mode!=="STUDENT_SELECT" || form.unlimited || (/^\d+$/.test(form.capacity) && Number.isSafeInteger(capacity) && capacity>0);
  const duplicate=context.activities.find(a=>a.id!==selected && a.session_question_id===form.question && (a.state==="DRAFT" || a.state==="OPEN"));
  const save=()=>{
    if(!canEdit || !validCapacity || !question)return;
    const request: PeerReviewDraft={session_id:sessionId,session_question_id:form.question,mode:form.mode,max_reviews_per_target:form.mode==="STUDENT_SELECT" && !form.unlimited ? capacity : null,session_group_set_id:form.mode==="CROSS_GROUP" ? form.groupSet || null : null};
    void mutate(()=>current ? api.updatePeerReviewActivityDraft(current.id,request) : api.createPeerReviewActivity(request));
  };
  return <section className="peer-review-page">
    <div className="page-heading compact"><div><h2>同儕互評</h2><p>目前課堂：{context.classroom_name}</p></div><div className="form-actions"><button className="button ghost" type="button" disabled={busy} onClick={back}>返回即時測驗</button><button className="button ghost" type="button" disabled={busy} onClick={()=>void refresh()}>重新載入</button></div></div>
    <p className="state-card">同儕互評只作為回饋紀錄，不計入正式成績。</p>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {context.session_state!=="ACTIVE" && <p role="status">課堂已結束或尚未開始，互評設定僅供檢視。</p>}
    <section className="list-card" aria-label="互評活動"><h3>互評活動</h3>
      {context.session_state==="ACTIVE" && <button className="button" type="button" disabled={busy} onClick={()=>choose("")}>建立互評活動</button>}
      {context.activities.length===0 && <p>尚未建立互評活動。</p>}
      <ul className="entity-list">{context.activities.map(a=>{const q=context.questions.find(q=>q.id===a.session_question_id);return <li key={a.id}><button className="text-button" type="button" disabled={busy} aria-pressed={selected===a.id} onClick={()=>choose(a.id)}>{q ? `${q.position+1}. ${q.prompt_summary}` : "論述題"} · {modes[a.mode]} · {states[a.state]}</button><small>建立：{a.created_at}{a.opened_at && ` · 開放：${a.opened_at}`}</small></li>;})}</ul>
    </section>
    <form className="form-card" onSubmit={event=>{event.preventDefault();save();}}>
      <h3>{current ? `活動設定 — ${states[current.state]}` : "新增活動設定"}</h3>
      <fieldset disabled={busy || !canEdit} style={{minWidth:0}}>
        <label className="field"><span>論述題目</span><select value={form.question} onChange={event=>{if(dirty && !confirmDiscard())return;const next={...saved!,question:event.target.value};setForm(next);}}><option value="">請選擇論述題</option>{context.questions.map(q=><option key={q.id} value={q.id}>{q.position+1}. {q.prompt_summary}（{questionStates[q.state]}）</option>)}</select></label>
        <label className="field"><span>互評方式</span><select value={form.mode} onChange={event=>setForm({...form,mode:event.target.value as PeerReviewMode})}>{Object.entries(modes).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        {form.mode==="RANDOM_ONE_TO_ONE" && <p>每位符合資格的學生會隨機分配 1 位其他學生，每份作品會收到 1 個互評指派。</p>}
        {form.mode==="STUDENT_SELECT" && <><label className="field"><span>每份作品最多可收到幾份評論</span><input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" disabled={form.unlimited} value={form.capacity} onChange={event=>setForm({...form,capacity:event.target.value})}/></label><label><input type="checkbox" checked={form.unlimited} onChange={event=>setForm({...form,unlimited:event.target.checked})}/>不限</label><p>此上限限制同一份作品最多可被多少位學生選擇，不是評論修改次數。</p><p>第一版每位學生最多選擇 1 份作品進行互評。</p>{!validCapacity && <p role="alert">評論上限須為有效正整數，或選擇不限。</p>}</>}
        {form.mode==="CROSS_GROUP" && <><label className="field"><span>分組版本</span><select value={form.groupSet} onChange={event=>setForm({...form,groupSet:event.target.value})}><option value="">請選擇分組版本</option>{context.group_sets.map((g,i)=><option key={g.id} value={g.id}>第 {g.revision} 版{i===0 ? "（目前）" : ""} · {g.created_at}</option>)}</select></label>{context.group_sets.length===0 && <p>目前沒有已完成的分組版本，請先完成課堂分組。</p>}<p>每個組別會被分配另一個組別的作品集合，整個組別共同提交一份評論。</p><p>互評使用所選的固定分組版本，之後重新分組不會改變這次互評。</p></>}
      </fieldset>
      {(!current || current.state==="DRAFT") && <div aria-label="開放前檢查"><h4>開放前檢查</h4>{form.mode==="CROSS_GROUP" ? <><p>可參與互評組別：{preflight?.eligible_group_count ?? 0}</p><ul>{preflight?.groups.map((g,i)=><li key={i}>{g.name} — {g.essay_count>0 ? `有 ${g.essay_count} 份論述答案` : "無可用作品"}</li>)}</ul></> : <><p>可參與互評：{question?.eligible_participant_count ?? 0} 人</p><p>可供選擇的作品：{question?.eligible_participant_count ?? 0}</p></>}{block && <p role="status">{block}</p>}<p>資格數是目前預檢；開放時由後端重新驗證。</p></div>}
      {duplicate && canEdit && <p role="alert">此題已有草稿或進行中的活動。<button type="button" onClick={()=>choose(duplicate.id)}>管理既有活動</button></p>}
      {current && current.state!=="DRAFT" && <><p>已固定作品：{current.frozen_target_count}</p><p>互評使用開放當下固定的作品版本。</p></>}
      {dirty && <p role="status">尚有未儲存的變更</p>}
      <div className="form-actions">
        {canEdit && <button className="button primary" type="submit" disabled={busy || !question || !validCapacity || !!duplicate || (form.mode==="CROSS_GROUP" && !form.groupSet)}>{current ? "儲存設定" : "儲存草稿"}</button>}
        {current?.state==="DRAFT" && context.session_state==="ACTIVE" && <><button className="button primary" type="button" disabled={busy || dirty || !!block} onClick={()=>{if(window.confirm("開放後會固定目前的論述答案版本，並鎖定本次互評設定。後續答案版本不會替換此次作品。"))void mutate(()=>api.openPeerReviewActivity(sessionId,current.id));}}>開放互評</button><button className="button ghost" type="button" disabled={busy} onClick={()=>{if(window.confirm("確定取消此草稿活動？尚未儲存的變更將放棄，歷史紀錄會保留。"))void mutate(()=>api.cancelPeerReviewActivity(sessionId,current.id));}}>取消活動</button></>}
        {current?.state==="OPEN" && context.session_state==="ACTIVE" && <button className="button" type="button" disabled={busy} onClick={()=>{if(window.confirm("結束後學生將無法再新增或修改評論，既有評論紀錄會保留。"))void mutate(()=>api.closePeerReviewActivity(sessionId,current.id));}}>結束互評</button>}
      </div>
    </form>
  </section>;
}
