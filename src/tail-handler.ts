import type { Env, TraceEvent, ErrorEntry } from './types.js';
import { recordLastSeen, bumpCounter } from './kv-coalesce.js';

export async function handleTail(events: TraceEvent[], env: Env): Promise<void> {
  for (const event of events) {
    // Write every event to Analytics Engine (hot data, queryable via SQL)
    env.TRACK_ANALYTICS.writeDataPoint({
      doubles: [
        event.eventTimestamp,
        event.logs.length,
        event.exceptions.length,
      ],
      blobs: [
        event.scriptName,
        event.outcome,
        event.event?.request?.method ?? '',
        event.event?.request?.url ?? '',
        truncate(JSON.stringify(event.logs.slice(0, 3)), 1000),
      ],
      indexes: [event.scriptName],
    });

    // Coalesced last-seen + event counter (see kv-coalesce.ts): was 2 KV ops
    // per event, now at most once/60s/worker. Analytics Engine above holds the
    // exact per-event data.
    await recordLastSeen(env, event.scriptName, event.eventTimestamp);
    await bumpCounter(env, `worker:${event.scriptName}:count`);

    // If errors or exceptions, write full detail to R2 (cold storage)
    if (event.outcome !== 'ok' || event.exceptions.length > 0) {
      const errorEntry: ErrorEntry = {
        worker: event.scriptName,
        timestamp: event.eventTimestamp,
        outcome: event.outcome,
        exceptions: event.exceptions,
        logs: event.logs,
        url: event.event?.request?.url,
        method: event.event?.request?.method,
      };

      const date = new Date(event.eventTimestamp).toISOString().split('T')[0];
      const key = `errors/${date}/${event.scriptName}/${event.eventTimestamp}.json`;
      await env.TRACK_ARCHIVE.put(key, JSON.stringify(errorEntry));

      // Coalesced error counter (see kv-coalesce.ts)
      await bumpCounter(env, `worker:${event.scriptName}:errors`);

      // Forward to chittyagent-resolve if bound
      if (env.RESOLVE_SERVICE) {
        try {
          await env.RESOLVE_SERVICE.fetch('https://resolve/api/v1/evaluate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(errorEntry),
          });
        } catch {
          // Don't let resolve failures break tail processing
        }
      }

      // Forward to mini evaluator swarm (Alchemist) if bound
      if (env.ALCHEMIST_SERVICE) {
        try {
          await env.ALCHEMIST_SERVICE.fetch('https://alchemist/api/v1/evaluate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(errorEntry),
          });
        } catch {
          // Don't let evaluator failures break tail processing
        }
      }

    }
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) : str;
}
