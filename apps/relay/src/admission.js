// Local admission bounds protect expensive dispatch, not globally distributed DoS.
// No credentials, participant IDs or Classroom data are retained here.
const RULES = Object.freeze({
  enroll: { burst: 8, rate: 0.1, globalBurst: 32, globalRate: 0.2 },
  operator: { burst: 16, rate: 1, globalBurst: 32, globalRate: 2 },
  teacher: { burst: 80, rate: 4, globalBurst: 256, globalRate: 16 },
  bootstrap: { burst: 160, rate: 16, globalBurst: 512, globalRate: 64 },
  join: { burst: 80, rate: 4, globalBurst: 256, globalRate: 16 },
  socket: { burst: 128, rate: 8, globalBurst: 512, globalRate: 32 },
  http: { burst: 256, rate: 64, globalBurst: 1024, globalRate: 256 },
  unknown: { burst: 32, rate: 2, globalBurst: 128, globalRate: 8 },
});
const MAX_IP_RECORDS = 1024;
const IDLE_RECORD_MS = 10 * 60 * 1000;
const MAX_PENDING_ISOLATE = 128;
const MAX_PENDING_IP = 64;

function route(path) {
  if (!path.startsWith("/v1/")) return null;
  if (path === "/v1/enroll") return "enroll";
  if (path.startsWith("/v1/operator/")) return "operator";
  if (path.startsWith("/v1/teacher/")) return "teacher";
  if (/^\/v1\/sessions\/[^/]+\/bootstrap$/.test(path)) return "bootstrap";
  if (/^\/v1\/sessions\/[^/]+\/join$/.test(path)) return "join";
  if (/^\/v1\/sessions\/[^/]+\/ws$/.test(path)) return "socket";
  if (/^\/v1\/sessions\/[^/]+\/http\//.test(path)) return "http";
  return "unknown";
}

function available(bucket, burst, rate, now) {
  return Math.min(burst, bucket.tokens + Math.max(0, now - bucket.at) * rate / 1000);
}
function take(bucket, tokens, now) {
  bucket.tokens = tokens - 1;
  bucket.at = now;
}

export class PublicAdmission {
  constructor(now = Date.now) {
    this.now = now;
    this.lastNow = 0;
    this.ips = new Map();
    this.buckets = new Map();
    this.pending = 0;
    this.nextSweep = 0;
  }

  acquire(request) {
    const kind = route(new URL(request.url).pathname);
    if (!kind) return () => {};
    const now = Math.max(this.lastNow, this.now());
    this.lastNow = now;
    const rule = RULES[kind];
    const global = this.buckets.get(kind) ?? { tokens: rule.globalBurst, at: now };
    const globalTokens = available(global, rule.globalBurst, rule.globalRate, now);
    // Rejected traffic must not allocate attacker-chosen keys or fill the map.
    if (this.pending >= MAX_PENDING_ISOLATE || globalTokens < 1) return null;
    // Cloudflare replaces this header at the public edge. Never fall back to
    // X-Forwarded-For, arbitrary participant headers or user-supplied tokens.
    // Missing/invalid platform metadata shares one conservative local bucket.
    const address = request.headers.get("cf-connecting-ip");
    const ip = address && address.length <= 64 && /^[0-9a-fA-F:.]+$/.test(address)
      ? address : "unknown";
    let entry = this.ips.get(ip);
    if (!entry) {
      if (this.ips.size >= MAX_IP_RECORDS) {
        if (now >= this.nextSweep) {
          this.nextSweep = now + 10000;
          for (const [key, candidate] of this.ips) {
            // Every bucket fully refills within this idle period. Evicting only
            // idle, inactive entries prevents key churn from resetting debt.
            if (!candidate.pending && now - candidate.lastSeen >= IDLE_RECORD_MS) this.ips.delete(key);
          }
        }
        if (this.ips.size >= MAX_IP_RECORDS) return null;
      }
      entry = { pending: 0, lastSeen: now, buckets: new Map() };
      this.ips.set(ip, entry);
    }
    entry.lastSeen = now;
    if (entry.pending >= MAX_PENDING_IP) return null;
    const local = entry.buckets.get(kind) ?? { tokens: rule.burst, at: now };
    const localTokens = available(local, rule.burst, rule.rate, now);
    if (localTokens < 1) return null;
    take(local, localTokens, now); take(global, globalTokens, now);
    entry.buckets.set(kind, local); this.buckets.set(kind, global);
    this.pending += 1; entry.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending -= 1; entry.pending -= 1;
    };
  }
}

export class SessionAdmission {
  constructor(now = Date.now) {
    this.now = now;
    this.lastNow = 0;
    this.buckets = new Map();
  }

  allow(path) {
    const kind = ({ "/join": "join", "/student-ws": "socket", "/http-read": "http" })[path];
    if (!kind) return true;
    const now = Math.max(this.lastNow, this.now());
    this.lastNow = now;
    const rule = RULES[kind];
    const bucket = this.buckets.get(kind) ?? { tokens: rule.burst, at: now };
    const tokens = available(bucket, rule.burst, rule.rate, now);
    if (tokens < 1) return false;
    take(bucket, tokens, now); this.buckets.set(kind, bucket);
    return true;
  }
}
