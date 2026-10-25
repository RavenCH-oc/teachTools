import { describe, expect, it } from "vitest";
import { remoteHttpOperationSchema, parseRemoteHttpEnvelope, REMOTE_HTTP_CHUNK_BYTES } from "./remote";
const id="00000000-0000-4000-8000-000000000001";
const envelope=(payload:unknown)=>JSON.stringify({v:1,type:"HTTP_RELAY",id,payload});
describe("Remote HTTP allowlist",()=>{
 it("represents the eight exact read operations without arbitrary URLs or methods",()=>{
  const operations=[
   {operation:"PEER_REVIEW_ACTIVITIES_LIST",arguments:{page:{limit:10,cursor:"opaque"}}},
   {operation:"PEER_REVIEW_ACTIVITY_GET",arguments:{activityId:id}},
   {operation:"PEER_REVIEW_CANDIDATES_LIST",arguments:{activityId:id,page:{}}},
   {operation:"PEER_REVIEW_ESSAYS_LIST",arguments:{assignmentId:id,page:{}}},
   {operation:"PEER_REVIEW_FEEDBACK_LIST",arguments:{activityId:id,page:{}}},
   {operation:"PEER_REVIEW_FEEDBACK_GET",arguments:{assignmentId:id}},
   {operation:"PEER_REVIEW_OWN_REVIEW_GET",arguments:{assignmentId:id}},
   {operation:"SESSION_ASSET_GET",arguments:{assetId:id}}];
  for(const request of operations){expect(remoteHttpOperationSchema.parse(request)).toEqual(request);expect(remoteHttpOperationSchema.safeParse({...request,path:"http://127.0.0.1/"}).success).toBe(false);}
 });
 it("rejects unknown operations, out of bounds pagination and path substitution",()=>{
  for(const request of [{operation:"HTTP_PROXY",arguments:{}},{operation:"SESSION_ASSET_GET",arguments:{assetId:"../../secret"}},
   {operation:"PEER_REVIEW_ACTIVITIES_LIST",arguments:{page:{limit:101}}},{operation:"PEER_REVIEW_ESSAYS_LIST",arguments:{activityId:id,page:{}}}]) expect(remoteHttpOperationSchema.safeParse(request).success).toBe(false);
 });
 it("binds requests and credits to UUID/generation and strict request identity",()=>{
  expect(parseRemoteHttpEnvelope(envelope({op:"HTTP_REQUEST",generation:2,identity:{sessionId:id,participantId:id,credential:"A".repeat(43)},request:{operation:"SESSION_ASSET_GET",arguments:{assetId:id}}})).type).toBe("HTTP_RELAY");
  for(const credits of [0,5])expect(()=>parseRemoteHttpEnvelope(envelope({op:"HTTP_CREDIT",generation:2,credits}))).toThrow();
 });
 it("fits full 32KiB chunk envelopes below 64KiB",()=>{
  const data=Buffer.alloc(REMOTE_HTTP_CHUNK_BYTES,255).toString("base64");
  const raw=envelope({op:"HTTP_RESPONSE_CHUNK",generation:2,sequence:0,data});expect(Buffer.byteLength(raw)).toBeLessThan(64*1024);expect(parseRemoteHttpEnvelope(raw).payload.op).toBe("HTTP_RESPONSE_CHUNK");
 });
 it("rejects arbitrary headers and whole-file chunks",()=>{
  expect(()=>parseRemoteHttpEnvelope(envelope({op:"HTTP_RESPONSE_START",generation:2,status:200,contentType:"application/pdf",contentLength:10,headers:{"set-cookie":"x"}}))).toThrow();
  expect(()=>parseRemoteHttpEnvelope(envelope({op:"HTTP_RESPONSE_CHUNK",generation:2,sequence:0,data:"A".repeat(70*1024)}))).toThrow("64 KiB");
 });
});
