// In-isolate write coalescing + kill switch for TRACK_STATE.
//
// chittytrack ingests the whole fleet's tail/OTLP stream (millions of events/day).
// Writing `lastSeen`/counter KV keys per event drove ~50M+ KV writes/month
// (the same handful of hot keys overwritten millions of times). Every event is
// already persisted to Analytics Engine (the exact source) and errors to R2, so
// these KV keys only need to stay ~current for the api.ts stats dashboard.
//
// Two layers:
//   1. Coalescing — write each key to KV at most once per FLUSH_MS, carrying the
//      latest lastSeen timestamp / accumulated counter delta. Counters were
//      already racy under concurrent isolates, so approximate is acceptable.
//   2. Kill switch + circuit breaker — a KV flag (`track:kv_writes_enabled`),
//      cached in-isolate, hard-disables all TRACK_STATE writes when "off"
//      (Analytics Engine still flows → zero data loss). If actual writes exceed
//      TRACK_KV_MAX_WRITES_PER_MIN, the breaker trips the flag off and it STAYS
//      off until an operator re-enables it via setKvWrites() (api admin route).
import type { Env } from './types.js';

const FLUSH_MS = 60_000;
const FLAG_KEY = 'track:kv_writes_enabled';
const DEFAULT_MAX_WRITES_PER_MIN = 2000;

// coalescing state (per isolate)
const lastSeenVal = new Map<string, number>(); // kvKey -> latest event timestamp
const lastSeenAt = new Map<string, number>(); // kvKey -> wallclock of last KV write
const counterDelta = new Map<string, number>(); // kvKey -> unflushed accumulated delta
const counterAt = new Map<string, number>(); // kvKey -> wallclock of last KV flush

// kill-switch state (in-isolate cache of the KV flag)
let enabled = true;
let flagCheckedAt = 0;

// circuit-breaker state (rolling ~60s window of actual KV writes)
let windowStart = 0;
let writesInWindow = 0;

function maxPerMin(env: Env): number {
  const n = parseInt(env.TRACK_KV_MAX_WRITES_PER_MIN ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_WRITES_PER_MIN;
}

/** True if KV writes are currently allowed. Re-reads the flag from KV at most once/60s. */
async function gateOpen(env: Env): Promise<boolean> {
  const now = Date.now();
  if (now - flagCheckedAt >= FLUSH_MS) {
    flagCheckedAt = now;
    try {
      enabled = (await env.TRACK_STATE.get(FLAG_KEY)) !== 'off';
    } catch {
      /* on read failure keep last known state */
    }
  }
  return enabled;
}

/** Account one real KV write against the breaker; trips the kill switch if over ceiling. */
async function allowWrite(env: Env): Promise<boolean> {
  const now = Date.now();
  if (now - windowStart >= FLUSH_MS) {
    windowStart = now;
    writesInWindow = 0;
  }
  writesInWindow++;
  if (writesInWindow > maxPerMin(env)) {
    await trip(env, writesInWindow);
    return false;
  }
  return true;
}

async function trip(env: Env, observed: number): Promise<void> {
  enabled = false;
  flagCheckedAt = Date.now(); // suppress immediate re-read
  try {
    await env.TRACK_STATE.put(FLAG_KEY, 'off');
    env.TRACK_ANALYTICS.writeDataPoint({
      blobs: ['kv_circuit_breaker_tripped', `observed=${observed}`, `max=${maxPerMin(env)}`],
      doubles: [Date.now(), observed],
      indexes: ['_track_alert'],
    });
  } catch {
    /* best effort */
  }
}

/** Record a worker's last-seen timestamp; writes to KV at most once per 60s. */
export async function recordLastSeen(env: Env, svc: string, ts: number): Promise<void> {
  const key = `worker:${svc}:lastSeen`;
  lastSeenVal.set(key, Math.max(ts, lastSeenVal.get(key) ?? 0));
  const now = Date.now();
  if (now - (lastSeenAt.get(key) ?? 0) < FLUSH_MS) return;
  if (!(await gateOpen(env))) return;
  if (!(await allowWrite(env))) return;
  lastSeenAt.set(key, now);
  await env.TRACK_STATE.put(key, String(lastSeenVal.get(key))).catch(() => {});
}

/** Increment a worker counter; flushes the accumulated delta to KV at most once per 60s. */
export async function bumpCounter(env: Env, key: string, by = 1): Promise<void> {
  counterDelta.set(key, (counterDelta.get(key) ?? 0) + by);
  const now = Date.now();
  if (now - (counterAt.get(key) ?? 0) < FLUSH_MS) return;
  if (!(await gateOpen(env))) return;
  if (!(await allowWrite(env))) return;
  counterAt.set(key, now);
  const delta = counterDelta.get(key) ?? 0;
  counterDelta.set(key, 0);
  const cur = parseInt((await env.TRACK_STATE.get(key)) ?? '0', 10);
  await env.TRACK_STATE.put(key, String(cur + delta));
}

/** Operator control: enable/disable TRACK_STATE writes (clears the breaker window on enable). */
export async function setKvWrites(env: Env, on: boolean): Promise<void> {
  enabled = on;
  flagCheckedAt = Date.now();
  if (on) {
    windowStart = Date.now();
    writesInWindow = 0;
  }
  await env.TRACK_STATE.put(FLAG_KEY, on ? 'on' : 'off');
}

/** Current kill-switch state (re-reads the flag at most once/60s). */
export function kvWritesEnabled(env: Env): Promise<boolean> {
  return gateOpen(env);
}
