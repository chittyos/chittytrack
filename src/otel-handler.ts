/**
 * OTLP HTTP receiver — accepts OpenTelemetry Protocol HTTP/JSON
 * from Cloudflare Workers' native observability export.
 *
 * Spec: https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md
 * Schema: https://opentelemetry.io/docs/specs/otlp/
 *
 * Persistence:
 *   - Analytics Engine (TRACK_ANALYTICS) for queryable traces/logs
 *   - R2 (TRACK_ARCHIVE) for full raw payload archive at otel/{kind}/{YYYY}/{MM}/{DD}/{ts}-{traceId}.json
 *   - KV (TRACK_STATE) for per-service last-seen + counts (already used by tail-handler)
 */

import type { Env } from "./types.js";

type AnyValue = { stringValue?: string; intValue?: string | number; boolValue?: boolean; doubleValue?: number; arrayValue?: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: KeyValue[];
  status?: { code?: number; message?: string };
}
interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber?: number;
  severityText?: string;
  body?: AnyValue;
  attributes?: KeyValue[];
  traceId?: string;
  spanId?: string;
}
interface OtlpResourceSpans {
  resource?: { attributes?: KeyValue[] };
  scopeSpans?: Array<{ scope?: { name?: string }; spans?: OtlpSpan[] }>;
}
interface OtlpResourceLogs {
  resource?: { attributes?: KeyValue[] };
  scopeLogs?: Array<{ scope?: { name?: string }; logRecords?: OtlpLogRecord[] }>;
}
interface OtlpTracesPayload { resourceSpans?: OtlpResourceSpans[] }
interface OtlpLogsPayload { resourceLogs?: OtlpResourceLogs[] }

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function flattenAttrs(kvs?: KeyValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!kvs) return out;
  for (const kv of kvs) {
    const v = kv.value;
    if (v.stringValue !== undefined) out[kv.key] = v.stringValue;
    else if (v.intValue !== undefined) out[kv.key] = Number(v.intValue);
    else if (v.boolValue !== undefined) out[kv.key] = v.boolValue;
    else if (v.doubleValue !== undefined) out[kv.key] = v.doubleValue;
    else if (v.arrayValue) out[kv.key] = v.arrayValue.values.map((x) => x.stringValue ?? x.intValue ?? x.boolValue ?? x.doubleValue);
  }
  return out;
}

function getServiceName(resourceAttrs: Record<string, unknown>): string {
  return String(resourceAttrs["service.name"] ?? "unknown");
}

function r2Key(kind: "traces" | "logs", traceOrLogId: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `otel/${kind}/${yyyy}/${mm}/${dd}/${now.getTime()}-${traceOrLogId.slice(0, 16)}.json`;
}

export async function handleOtlpTraces(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return new Response(JSON.stringify({ code: 12, message: "Method not allowed" }), { status: 405, headers: { "content-type": "application/json", ...CORS } });

  let payload: OtlpTracesPayload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ code: 3, message: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json", ...CORS } });
  }

  let spanCount = 0;
  const services = new Set<string>();
  const archive: { ts: number; service: string; payload: OtlpTracesPayload } = { ts: Date.now(), service: "", payload };

  for (const rs of payload.resourceSpans ?? []) {
    const resAttrs = flattenAttrs(rs.resource?.attributes);
    const service = getServiceName(resAttrs);
    services.add(service);
    archive.service = service;
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        spanCount++;
        const spanAttrs = flattenAttrs(span.attributes);
        try {
          env.TRACK_ANALYTICS.writeDataPoint({
            blobs: [
              service,
              span.name,
              span.traceId,
              span.spanId,
              span.parentSpanId ?? "",
              ss.scope?.name ?? "",
              String(span.kind ?? 0),
              JSON.stringify({ resource: resAttrs, attrs: spanAttrs, status: span.status }),
            ],
            doubles: [
              Number(span.startTimeUnixNano) / 1e9,
              Number(span.endTimeUnixNano) / 1e9,
              (Number(span.endTimeUnixNano) - Number(span.startTimeUnixNano)) / 1e6, // duration ms
            ],
            indexes: [service],
          });
        } catch (e) {
          console.error("Analytics Engine write failed", e);
        }
      }
    }
  }

  // Archive raw payload to R2 (use first traceId for filename keying)
  const firstTrace = payload.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.traceId ?? `nb-${Date.now()}`;
  try {
    await env.TRACK_ARCHIVE.put(r2Key("traces", firstTrace), JSON.stringify(archive), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { service: archive.service, span_count: String(spanCount) },
    });
  } catch (e) {
    console.error("R2 archive write failed", e);
  }

  // Update per-service KV counters
  for (const svc of services) {
    await Promise.allSettled([
      env.TRACK_STATE.put(`worker:${svc}:lastSeen`, String(Date.now())),
    ]);
  }

  return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200, headers: { "content-type": "application/json", ...CORS } });
}

export async function handleOtlpLogs(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (request.method !== "POST") return new Response(JSON.stringify({ code: 12, message: "Method not allowed" }), { status: 405, headers: { "content-type": "application/json", ...CORS } });

  let payload: OtlpLogsPayload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ code: 3, message: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json", ...CORS } });
  }

  let logCount = 0;
  let errorCount = 0;
  const services = new Set<string>();

  for (const rl of payload.resourceLogs ?? []) {
    const resAttrs = flattenAttrs(rl.resource?.attributes);
    const service = getServiceName(resAttrs);
    services.add(service);
    for (const sl of rl.scopeLogs ?? []) {
      for (const log of sl.logRecords ?? []) {
        logCount++;
        const isError = (log.severityNumber ?? 0) >= 17 || (log.severityText ?? "").toUpperCase().startsWith("ERROR");
        if (isError) errorCount++;
        const logAttrs = flattenAttrs(log.attributes);
        const bodyStr = log.body?.stringValue ?? JSON.stringify(log.body ?? null);
        try {
          env.TRACK_ANALYTICS.writeDataPoint({
            blobs: [
              service,
              log.severityText ?? "UNSET",
              log.traceId ?? "",
              log.spanId ?? "",
              ss(bodyStr, 4000),
              ss(JSON.stringify({ resource: resAttrs, attrs: logAttrs }), 4000),
              ss(sl.scope?.name ?? "", 200),
            ],
            doubles: [Number(log.timeUnixNano) / 1e9, log.severityNumber ?? 0],
            indexes: [service],
          });
        } catch (e) {
          console.error("Analytics Engine write failed", e);
        }
      }
    }
  }

  // Archive + update counters
  const firstTrace = payload.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords?.[0]?.traceId ?? `nb-${Date.now()}`;
  try {
    await env.TRACK_ARCHIVE.put(r2Key("logs", firstTrace), JSON.stringify({ ts: Date.now(), payload }), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { log_count: String(logCount), error_count: String(errorCount) },
    });
  } catch (e) { console.error("R2 archive write failed", e); }

  for (const svc of services) {
    await Promise.allSettled([
      env.TRACK_STATE.put(`worker:${svc}:lastSeen`, String(Date.now())),
      errorCount > 0 ? incrementKV(env, `worker:${svc}:errors`, errorCount) : Promise.resolve(),
    ]);
  }

  return new Response(JSON.stringify({ partialSuccess: {} }), { status: 200, headers: { "content-type": "application/json", ...CORS } });
}

function ss(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "...(truncated)" : s;
}

async function incrementKV(env: Env, key: string, by: number): Promise<void> {
  const cur = parseInt((await env.TRACK_STATE.get(key)) ?? "0", 10);
  await env.TRACK_STATE.put(key, String(cur + by));
}
