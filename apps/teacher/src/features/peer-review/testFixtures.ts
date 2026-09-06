import { vi } from "vitest";
import type { PeerReviewActivity, PeerReviewDraft, PeerReviewSetup } from "@classtools/validation";
import type { PeerReviewApi } from "../../services/peerReviewApi";

export function setupFixture(): PeerReviewSetup {
  return {session_id:"session",session_state:"ACTIVE",classroom_name:"測試班級",questions:[{id:"essay",position:0,prompt_summary:"解釋原因",state:"LOCKED",eligible_participant_count:3},{id:"other",position:1,prompt_summary:"另一題",state:"REVEALED",eligible_participant_count:2}],activities:[],group_sets:[2,1].map(revision=>({id:`set-${revision}`,revision,created_at:"2026-09-06T00:00:00Z",questions:["essay","other"].map(session_question_id=>({session_question_id,eligible_group_count:2,groups:[{name:"第一組",essay_count:2},{name:"第二組",essay_count:1},{name:"第三組",essay_count:0}]}))}))};
}
export function draftFixture(): PeerReviewActivity {
  return {id:"activity",session_question_id:"essay",mode:"RANDOM_ONE_TO_ONE",state:"DRAFT",max_reviews_per_target:null,session_group_set_id:null,created_at:"2026-09-06T00:00:00Z",opened_at:null,closed_at:null,frozen_target_count:0};
}
export function reviewApiFixture(context:PeerReviewSetup): PeerReviewApi {
  const save=(id:string,r:PeerReviewDraft)=>{const a={...draftFixture(),id,...r};context.activities=[a,...context.activities.filter(x=>x.id!==id)];return Promise.resolve(a);};
  const transition=(id:string,state:PeerReviewActivity["state"])=>{
    const a=context.activities.find(a=>a.id===id);if(!a)throw new Error("missing fixture");
    a.state=state;if(state==="OPEN"){a.frozen_target_count=3;a.opened_at="2026-09-06T01:00:00Z";}return Promise.resolve({...a});
  };
  return {
    getPeerReviewSetupContext:vi.fn().mockImplementation(async()=>structuredClone(context)),
    createPeerReviewActivity:vi.fn().mockImplementation(r=>save(`activity-${context.activities.length}`,r)),
    updatePeerReviewActivityDraft:vi.fn().mockImplementation(save),
    openPeerReviewActivity:vi.fn().mockImplementation((_s,id)=>transition(id,"OPEN")),
    closePeerReviewActivity:vi.fn().mockImplementation((_s,id)=>transition(id,"CLOSED")),
    cancelPeerReviewActivity:vi.fn().mockImplementation((_s,id)=>transition(id,"CANCELLED")),
  };
}
