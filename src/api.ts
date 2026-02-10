import type { Env, WorkerStats } from './types.js';

export async function handleApi(
  path: string,
  request: Request,
  env: Env,
): Promise<Response> {
  if (path === '/api/v1/workers') {
    return getWorkers(env);
  }
  if (path === '/api/v1/errors') {
    return getErrors(request, env);
  }
  if (path === '/api/v1/stats') {
    return getStats(env);
  }
  if (path === '/api/v1/query') {
    return handleQuery(request, env);
  }

  return json({ error: 'Not found' }, 404);
}

async function getWorkers(env: Env): Promise<Response> {
  const list = await env.TRACK_STATE.list({ prefix: 'worker:' });
  const workers = new Map<string, WorkerStats>();

  for (const key of list.keys) {
    const parts = key.name.split(':');
    if (parts.length < 3) continue;
    const worker = parts[1];
    const field = parts[2];
    const value = await env.TRACK_STATE.get(key.name);

    if (!workers.has(worker)) {
      workers.set(worker, {
        worker,
        lastSeen: 0,
        totalEvents: 0,
        errorCount: 0,
      });
    }

    const stats = workers.get(worker)!;
    if (field === 'lastSeen') stats.lastSeen = parseInt(value ?? '0', 10);
    if (field === 'count') stats.totalEvents = parseInt(value ?? '0', 10);
    if (field === 'errors') stats.errorCount = parseInt(value ?? '0', 10);
  }

  const result = Array.from(workers.values()).sort(
    (a, b) => b.lastSeen - a.lastSeen,
  );

  return json({ workers: result, count: result.length });
}

async function getErrors(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const worker = url.searchParams.get('worker');
  const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
  const date = url.searchParams.get('date') ?? new Date().toISOString().split('T')[0];

  let prefix = `errors/${date}/`;
  if (worker) prefix += `${worker}/`;

  const listed = await env.TRACK_ARCHIVE.list({ prefix, limit });
  const errors = await Promise.all(
    listed.objects.map(async (obj) => {
      const body = await env.TRACK_ARCHIVE.get(obj.key);
      if (!body) return null;
      return JSON.parse(await body.text());
    }),
  );

  return json({
    errors: errors.filter(Boolean),
    count: errors.filter(Boolean).length,
    date,
    worker: worker ?? 'all',
  });
}

async function getStats(env: Env): Promise<Response> {
  const list = await env.TRACK_STATE.list({ prefix: 'worker:' });
  let totalEvents = 0;
  let totalErrors = 0;
  let workerCount = 0;
  const seen = new Set<string>();

  for (const key of list.keys) {
    const parts = key.name.split(':');
    if (parts.length < 3) continue;
    const worker = parts[1];
    const field = parts[2];
    const value = parseInt((await env.TRACK_STATE.get(key.name)) ?? '0', 10);

    if (!seen.has(worker)) {
      seen.add(worker);
      workerCount++;
    }

    if (field === 'count') totalEvents += value;
    if (field === 'errors') totalErrors += value;
  }

  return json({
    workers: workerCount,
    totalEvents,
    totalErrors,
    errorRate: totalEvents > 0 ? (totalErrors / totalEvents * 100).toFixed(2) + '%' : '0%',
  });
}

async function handleQuery(_request: Request, _env: Env): Promise<Response> {
  // Analytics Engine SQL API queries require account-level API token
  // This endpoint is a placeholder for future direct SQL proxy
  return json({
    message: 'Query endpoint ready. Use Cloudflare dashboard or API for Analytics Engine SQL queries.',
    dataset: 'chittytrack_logs',
    hint: 'POST to https://api.cloudflare.com/client/v4/accounts/{account_id}/analytics_engine/sql',
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
