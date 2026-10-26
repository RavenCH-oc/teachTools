import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { HttpRelay, HTTP_CHUNK_BYTES, HTTP_WINDOW, HTTP_LIMITS, publicHttpRequest, validHttpOperation } from "./http_relay.js";
// Runtime-compatible length enforcement for isolated Node transport tests.
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(length) { let bytes = 0; super({ transform(chunk, controller) { bytes += chunk.byteLength; if (bytes > length) throw new Error("Length exceeded"); controller.enqueue(chunk); }, flush() { if (bytes !== length) throw new Error("Length mismatch"); } }); }
};
const uuid = "00000000-0000-4000-8000-000000000001";
const identity = { sessionId: uuid, participantId: uuid, credential: "A".repeat(43) };
const quotaOwner = identity => createHash("sha256").update(JSON.stringify([identity.sessionId, identity.participantId, identity.credential])).digest("hex");
const headers = () => new Headers({ authorization: "Bearer " + identity.credential, "x-classroom-session": uuid, "x-classroom-participant": uuid });
const operation = { operation: "PEER_REVIEW_ACTIVITIES_LIST", arguments: { page: {} } };
function fixture(media = false) {
  let now = 1000; const frames = []; const teacher = {};
  const relay = new HttpRelay((socket, raw) => { frames.push(JSON.parse(raw)); return true; }, () => {}, () => now);
  const controller = new AbortController();
  const response = relay.open(new Request("http://test/", { signal: controller.signal }), { identity,
    request: media ? { operation: "SESSION_ASSET_GET", arguments: { assetId: uuid } } : operation }, 1, teacher, quotaOwner(identity));
  const id = frames[0].id;
  const send = payload => relay.handle({ id, payload: { generation: 1, ...payload } }, teacher);
  return { relay, frames, teacher, controller, response, id, send, advance: ms => { now += ms; relay.expire(); } };
}
const start = (f, length, contentType = "application/json") => f.send({ op: "HTTP_RESPONSE_START", status: 200, contentType, contentLength: length });
const chunk = (f, sequence, bytes) => f.send({ op: "HTTP_RESPONSE_CHUNK", sequence, data: Buffer.from(bytes).toString("base64") });
test("H1/H2 unknown operations, URL/path/query and traversal cannot enter the allowlist", () => {
  for (const request of [{ operation: "PROXY", arguments: {} }, { ...operation, path: "http://127.0.0.1" },
    { operation: "SESSION_ASSET_GET", arguments: { assetId: "../../file" } }, { ...operation, arguments: { page: {}, url: "file:///secret" } }]) assert.equal(validHttpOperation(request), false);
  for (const key of ["__proto__", "constructor", "toString"]) {
    assert.equal(validHttpOperation({ operation: key, arguments: {} }), false);
    assert.equal(publicHttpRequest(new URL("http://x/"), headers(), key), null);
  }
  assert.equal(publicHttpRequest(new URL("http://x/?credential=secret"), headers(), operation.operation), null);
  assert.equal(publicHttpRequest(new URL("http://x/?cursor=a&cursor=b"), headers(), operation.operation), null);
});
test("H3 public identity must be carried in authenticated headers, never URL/query", () => {
  assert.equal(publicHttpRequest(new URL("http://x/"), new Headers(), operation.operation), null);
  assert.deepEqual(publicHttpRequest(new URL("http://x/?limit=10&cursor=opaque"), headers(), operation.operation),
    { identity, request: { ...operation, arguments: { page: { limit: 10, cursor: "opaque" } } } });
});
test("S1/S2/S3/S4/S5 ordered chunks reconstruct exact bytes with a bounded credit window", async () => {
  const f = fixture(true); const bytes = Buffer.alloc(HTTP_CHUNK_BYTES * 9 + 7, 173);
  start(f, bytes.length, "application/pdf"); const response = await f.response;
  const received = response.arrayBuffer();
  let sequence = 0;
  for (let offset = 0; offset < bytes.length; offset += HTTP_CHUNK_BYTES) {
    while (f.relay.pending.get(f.id)?.credits === 0) await new Promise(resolve => setImmediate(resolve));
    chunk(f, sequence++, bytes.subarray(offset, offset + HTTP_CHUNK_BYTES));
    const entry = f.relay.pending.get(f.id);
    assert.ok(entry.credits + entry.queue.length <= HTTP_WINDOW);
    await Promise.resolve();
  }
  f.send({ op: "HTTP_RESPONSE_END", chunks: sequence, bytes: bytes.length });
  assert.deepEqual(Buffer.from(await received), bytes);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(f.relay.pending.size, 0);
  for (const frame of f.frames) assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 64 * 1024);
});
test("S5 a Teacher cannot send beyond credits when the browser stops consuming", async () => {
  const f = fixture(true); start(f, HTTP_CHUNK_BYTES * 10, "image/png"); const response = await f.response;
  let sequence = 0;
  while (f.relay.pending.get(f.id).credits > 0) {
    chunk(f, sequence++, Buffer.alloc(HTTP_CHUNK_BYTES));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(sequence <= HTTP_WINDOW + 2);
  }
  assert.equal(f.relay.pending.get(f.id).queue.length, 4);
  chunk(f, sequence, Buffer.alloc(HTTP_CHUNK_BYTES));
  await assert.rejects(response.arrayBuffer(), /interrupted/);
  assert.equal(f.relay.pending.size, 0);
});
test("S6 browser stream cancellation immediately removes correlation and sends CANCEL", async () => {
  const f = fixture(true); start(f, 100, "image/png"); const response = await f.response;
  await response.body.cancel();
  assert.equal(f.relay.pending.size, 0);
  assert.equal(f.frames.at(-1).payload.op, "HTTP_CANCEL");
});
test("S6 navigation abort before headers removes correlation without waiting for timeout", async () => {
  const f = fixture(); f.controller.abort();
  assert.equal((await f.response).status, 503);
  assert.equal(f.relay.pending.size, 0);
  assert.equal(f.frames.at(-1).payload.op, "HTTP_CANCEL");
});
test("S7 detail total and media idle timeout clean native and DO state", async () => {
  const detail=fixture(); detail.advance(HTTP_LIMITS.detailTimeout);
  assert.equal((await detail.response).status,504); assert.equal(detail.relay.pending.size,0);
  const media=fixture(true); start(media,100,"application/pdf"); const response=await media.response;
  media.advance(HTTP_LIMITS.mediaIdle); await assert.rejects(response.arrayBuffer(), /interrupted/);
  assert.equal(media.frames.at(-1).payload.op,"HTTP_CANCEL");
});
test("S8/S9 Teacher disconnect/generation change fails old stream and ignores stale chunks", async () => {
  const f=fixture(true); start(f,100,"application/pdf"); const response=await f.response;
  f.relay.handle({id:f.id,payload:{op:"HTTP_RESPONSE_END",generation:2,chunks:0,bytes:0}},f.teacher);
  assert.equal(f.relay.pending.size,1);
  f.relay.failAll(); await assert.rejects(response.arrayBuffer(), /interrupted/);
  f.send({op:"HTTP_RESPONSE_CHUNK",sequence:0,data:"YQ=="});
  assert.equal(f.relay.pending.size,0); assert.equal(f.frames.at(-1).payload.op,"HTTP_CANCEL");
});
test("S10 reordered, truncated or failed streams cannot silently succeed", async () => {
  for (const payload of [{op:"HTTP_RESPONSE_END",chunks:0,bytes:0},
    {op:"HTTP_RESPONSE_CHUNK",sequence:1,data:"YQ=="}, {op:"HTTP_ERROR",code:"RESPONSE_INVALID"}]) {
    const f=fixture(); start(f,10); const response=await f.response; f.send(payload);
    await assert.rejects(response.arrayBuffer(), /interrupted/); assert.equal(f.relay.pending.size,0);
  }
});
test("metadata is an allowlist and cannot forward cookies, paths or arbitrary MIME", async () => {
  const f=fixture(); f.send({op:"HTTP_RESPONSE_START",status:200,contentType:"application/json",contentLength:10,headers:{"set-cookie":"secret"}});
  assert.equal((await f.response).status,503); assert.equal(f.relay.pending.size,0);
});
test("explicit per participant and Session request/media bounds fail retryably", async () => {
  const f=fixture(true);
  const response=await f.relay.open(new Request("http://test/"),{identity,request:{operation:"SESSION_ASSET_GET",arguments:{assetId:uuid}}},1,f.teacher,quotaOwner(identity));
  assert.equal(response.status,429); assert.equal(f.relay.pending.size,1);
  f.relay.failAll(); await f.response;
});
test("H7 request correlation never retains credentials or raw request bodies", async () => {
  const f=fixture(); const entry=f.relay.pending.get(f.id);
  assert.equal("identity" in entry,false); assert.equal("request" in entry,false); assert.equal("credential" in entry,false);
  assert.equal(JSON.stringify({...entry,signal:undefined,stream:undefined,controller:undefined,teacher:undefined}).includes(identity.credential),false);
  f.relay.failAll(); await f.response;
});

test("Session-wide and per-participant request/media limits are bounded", async () => {
  for (const [media, count] of [[false, HTTP_LIMITS.requests], [true, HTTP_LIMITS.media]]) {
    const frames=[];const teacher={};const relay=new HttpRelay((_socket,raw)=>{frames.push(JSON.parse(raw));return true;},()=>{});
    const responses=[];
    for(let index=0;index<count;index++){
      const owner={...identity,participantId:crypto.randomUUID()};
      responses.push(relay.open(new Request("http://test/"),{identity:owner,request:media?{operation:"SESSION_ASSET_GET",arguments:{assetId:uuid}}:operation},1,teacher,quotaOwner(owner)));
    }
    const rejectedIdentity={...identity,participantId:crypto.randomUUID()};
    const rejected=await relay.open(new Request("http://test/"),{identity:rejectedIdentity,request:media?{operation:"SESSION_ASSET_GET",arguments:{assetId:uuid}}:operation},1,teacher,quotaOwner(rejectedIdentity));
    assert.equal(rejected.status,429);assert.equal(relay.pending.size,count);
    relay.failAll();await Promise.all(responses);
  }
  const f=fixture();const responses=[];
  for(let index=0;index<3;index++)responses.push(f.relay.open(new Request("http://test/"),{identity,request:operation},1,f.teacher,quotaOwner(identity)));
  assert.equal((await f.relay.open(new Request("http://test/"),{identity,request:operation},1,f.teacher,quotaOwner(identity))).status,429);
  assert.equal(f.relay.pending.size,4);f.relay.failAll();await Promise.all([f.response,...responses]);
});


test("A2 cancellation discards scheduled CREDIT before another Teacher generation can receive it", async () => {
  const f = fixture(true); start(f, HTTP_CHUNK_BYTES * 4, "application/pdf");
  const response = await f.response; const reader = response.body.getReader();
  const first = reader.read(); chunk(f, 0, Buffer.alloc(HTTP_CHUNK_BYTES));
  await first;
  assert.equal(f.frames.filter(frame => frame.payload.op === "HTTP_CREDIT").length, 1, "only initial four-credit grant is synchronous");
  assert.ok(f.relay.queuedCredits.size <= HTTP_LIMITS.requests);
  for (const credits of f.relay.queuedCredits.values()) assert.ok(credits <= HTTP_WINDOW);
  f.relay.failAll();
  await assert.rejects(reader.read(), /interrupted/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.frames.filter(frame => frame.payload.op === "HTTP_CREDIT").length, 1, "canceled generation must not emit replenishment later");
  assert.equal(f.relay.queuedCredits.size, 0);
  assert.equal(f.relay.creditTimer, null);
  assert.equal(f.relay.pending.size, 0);
});

test("A2 valid stream completion removes any queued CREDIT and timer", async () => {
  const f = fixture(true); start(f, 1, "application/pdf");
  const response = await f.response; const body = response.arrayBuffer();
  chunk(f, 0, Buffer.from([42])); f.send({ op: "HTTP_RESPONSE_END", chunks: 1, bytes: 1 });
  assert.deepEqual(Buffer.from(await body), Buffer.from([42]));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.frames.filter(frame => frame.payload.op === "HTTP_CREDIT").length, 1);
  assert.equal(f.relay.queuedCredits.size, 0);
  assert.equal(f.relay.creditTimer, null);
  assert.equal(f.relay.pending.size, 0);
});
