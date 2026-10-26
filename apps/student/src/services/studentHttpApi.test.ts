import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPeerReviewActivities, getPeerReviewEssays, getPeerReviewFeedbackDetail, getOwnPeerReview } from "./peerReviewApi";
import { fetchSessionAsset, type StoredParticipant } from "./studentApi";
import { studentHttpRead } from "./studentHttpApi";
const id="019fe91e-7606-7d00-aede-59c50a724f4d";
const participant: StoredParticipant = { sessionId:id, participantId:id, serverInstanceId:`remote:${"a".repeat(32)}`, credential:"A".repeat(43), participant:{sessionId:id,participantId:id,seatNumber:1,displayName:"測試"} };
afterEach(()=>{ vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

describe("bounded Remote media saturation retry", () => {
 const operation = { operation: "SESSION_ASSET_GET", arguments: { assetId: id } } as const;
 const saturated = (code = "REMOTE_SERVICE_UNAVAILABLE") => new Response(JSON.stringify({ code }), {
  status: 429, headers: { "content-type": "application/json" },
 });
 beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
 });
 it("retries a recognized saturation response without requiring an AbortSignal", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(saturated()).mockResolvedValueOnce(new Response("image"));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(124);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await (await result).text()).toBe("image");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
 });
 it("jitters the delay rather than synchronizing all Students", async () => {
  vi.mocked(Math.random).mockReturnValue(0.5);
  const fetchMock = vi.fn().mockResolvedValueOnce(saturated()).mockResolvedValueOnce(new Response("image"));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(186);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await result).status).toBe(200);
 });
 it("stops after 16 retries and preserves the final controlled response", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(saturated()));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.runAllTimersAsync();
  const response = await result;
  expect(fetchMock).toHaveBeenCalledTimes(17);
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ code: "REMOTE_SERVICE_UNAVAILABLE" });
  expect(performance.now()).toBeLessThan(30_000);
  expect(vi.getTimerCount()).toBe(0);
 });
 it("stops admitting retries after the 30 second budget including request latency", async () => {
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(saturated()), 10_000)));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.runAllTimersAsync();
  expect((await result).status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
 });
 it("aborts a pending backoff immediately and does not fetch again", async () => {
  const fetchMock = vi.fn().mockResolvedValue(saturated());
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  const result = studentHttpRead(participant, operation, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  await vi.runAllTimersAsync();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
 });
 it("does not fetch for an already aborted request", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController(); controller.abort();
  await expect(studentHttpRead(participant, operation, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock).not.toHaveBeenCalled();
 });
 it.each([401, 403, 500, 503])("does not retry HTTP %i", async (status) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("error", { status }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await studentHttpRead(participant, operation)).status).toBe(status);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
 });
 it("does not retry Remote detail or LAN media", async () => {
  const fetchMock = vi.fn(() => Promise.resolve(saturated()));
  vi.stubGlobal("fetch", fetchMock);
  expect((await studentHttpRead(participant, { operation: "PEER_REVIEW_ACTIVITIES_LIST", arguments: { page: {} } })).status).toBe(429);
  expect((await studentHttpRead({ ...participant, serverInstanceId: id }, operation)).status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
 });
 it.each(["AUTH_FAILED", "UNKNOWN_ERROR"])("does not retry an unrecognized 429 code %s", async (code) => {
  const fetchMock = vi.fn().mockResolvedValue(saturated(code));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(0);
  const response = await result;
  expect(await response.json()).toEqual({ code });
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("bounds inspection even if a 429 body lies about its length", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "REMOTE_SERVICE_UNAVAILABLE", extra: "x".repeat(2_000) }), {
   status: 429, headers: { "content-type": "application/json", "content-length": "1" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(0);
  expect((await result).status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it.each([
  { body: '{"code":"REMOTE_SERVICE_UNAVAILABLE"}', headers: new Headers({ "content-type": "text/html" }) },
  { body: '{"code":', headers: new Headers({ "content-type": "application/json" }) },
  { body: '{"code":"REMOTE_SERVICE_UNAVAILABLE"}', headers: new Headers({ "content-type": "application/json", "content-length": "1000000" }) },
 ])("does not retry malformed or non-contract 429 responses: %j", async ({ body, headers }) => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 429, headers }));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(0);
  expect((await result).status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(1);
 });
 it("bounds inspection of an unfinished 429 body", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream(), {
   status: 429, headers: { "content-type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const result = studentHttpRead(participant, operation);
  await vi.advanceTimersByTimeAsync(1_000);
  const response = await result;
  expect(response.status).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  void response.body?.cancel();
 });
 it("aborts unfinished error inspection immediately", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream(), {
   status: 429, headers: { "content-type": "application/json" },
  })));
  const controller = new AbortController();
  const result = studentHttpRead(participant, operation, controller.signal);
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(0);
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
 });
 it("does not retry a network failure or interrupted successful media body", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("network"));
  vi.stubGlobal("fetch", fetchMock);
  await expect(studentHttpRead(participant, operation)).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  const stream = new ReadableStream({ start(controller) { controller.error(new Error("body interrupted")); } });
  fetchMock.mockResolvedValueOnce(new Response(stream));
  await expect(fetchSessionAsset(id, participant)).rejects.toMatchObject({ code: "RESPONSE_INTERRUPTED" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
 });
});
