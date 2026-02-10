import type { Env, TraceEvent, ErrorEntry } from './types.js';

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

    // Track last-seen per worker in KV
    await env.TRACK_STATE.put(
      `worker:${event.scriptName}:lastSeen`,
      String(event.eventTimestamp),
    );

    // Increment event counter
    const countKey = `worker:${event.scriptName}:count`;
    const current = parseInt((await env.TRACK_STATE.get(countKey)) ?? '0', 10);
    await env.TRACK_STATE.put(countKey, String(current + 1));

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

      // Increment error counter
      const errKey = `worker:${event.scriptName}:errors`;
      const errCount = parseInt((await env.TRACK_STATE.get(errKey)) ?? '0', 10);
      await env.TRACK_STATE.put(errKey, String(errCount + 1));

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
    }
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) : str;
}
