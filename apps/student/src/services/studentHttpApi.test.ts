import { afterEach, describe, expect, it, vi } from "vitest";
import { getPeerReviewActivities, getPeerReviewEssays, getPeerReviewFeedbackDetail, getOwnPeerReview } from "./peerReviewApi";
import { fetchSessionAsset, type StoredParticipant } from "./studentApi";
import { studentHttpRead } from "./studentHttpApi";
const id="019fe91e-7606-7d00-aede-59c50a724f4d";
const participant: StoredParticipant = { sessionId:id, participantId:id, serverInstanceId:`remote:${"a".repeat(32)}`, credential:"A".repeat(43), participant:{sessionId:id,participantId:id,seatNumber:1,displayName:"測試"} };
afterEach(()=>vi.unstubAllGlobals());
describe("Remote HTTP detail/media",()=>{
 it("keeps operation arguments typed, cursor opaque, credential in headers, signal forwarded",async()=>{
  const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[],nextCursor:null})));vi.stubGlobal("fetch",fetchMock);
  const controller=new AbortController(); await getPeerReviewActivities(participant,{cursor:"opaque",limit:7,signal:controller.signal});
  expect(fetchMock).toHaveBeenCalledWith(`/v1/sessions/${"a".repeat(32)}/http/PEER_REVIEW_ACTIVITIES_LIST?limit=7&cursor=opaque`,expect.objectContaining({signal:controller.signal,headers:expect.objectContaining({authorization:`Bearer ${participant.credential}`})}));
  expect(fetchMock.mock.calls[0]?.[0]).not.toContain(participant.credential);
 });
 it("uses assignment scope for Essay revisions, feedback and own review",async()=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({items:[{peerReviewTargetId:id,label:"同學",essay:"固定 revision 作品"}],nextCursor:null})))
    .mockResolvedValueOnce(new Response(JSON.stringify({assignmentId:id,revision:2,body:"回饋"})))
    .mockResolvedValueOnce(new Response("null"));vi.stubGlobal("fetch",fetchMock);
  expect((await getPeerReviewEssays(participant,id)).items[0]?.essay).toBe("固定 revision 作品");
  expect((await getPeerReviewFeedbackDetail(participant,id)).revision).toBe(2);expect(await getOwnPeerReview(participant,id)).toBeNull();
  expect(fetchMock.mock.calls.every(([path])=>String(path).includes("assignmentId="))).toBe(true);
 });
 it("returns exact authenticated image and PDF bytes/MIME",async()=>{
  for(const type of ["image/png","application/pdf"]) {
   const bytes=new Uint8Array([0,1,255,127]);vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(bytes,{headers:{"content-type":type}})));
   const blob=await fetchSessionAsset(id,participant);expect(blob.type).toBe(type);const read = await new Promise<ArrayBuffer>((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve(reader.result as ArrayBuffer); reader.onerror=()=>reject(new Error("blob")); reader.readAsArrayBuffer(blob); }); expect(new Uint8Array(read)).toEqual(bytes);
  }
 });
 it("shows controlled Teacher-offline and timeout errors",async()=>{
  for(const [code,message] of [["TEACHER_UNAVAILABLE","教師端暫時離線"],["REQUEST_TIMEOUT","讀取逾時"]] as const) {
   vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({code,message:"controlled"}),{status:503})));
   await expect(getPeerReviewActivities(participant)).rejects.toMatchObject({code,message:expect.stringContaining(message)});
  }
 });
 it("rejects partial successful HTTP bodies instead of displaying truncated detail",async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"items":['));c.error(new Error("transport"));}});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(stream)));
  await expect(getPeerReviewActivities(participant)).rejects.toMatchObject({code:"RESPONSE_INTERRUPTED"});
 });
 it("preserves browser AbortError for cancellation",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new DOMException("cancel","AbortError")));
  await expect(fetchSessionAsset(id,participant,new AbortController().signal)).rejects.toMatchObject({name:"AbortError"});
 });
 it("rejects path traversal and forged argument fields before fetch",async()=>{
  const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
  await expect(studentHttpRead(participant,{operation:"SESSION_ASSET_GET",arguments:{assetId:"../file"}})).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
 });
});
