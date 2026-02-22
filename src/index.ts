import type { Env, TraceEvent } from './types.js';
import { handleTail } from './tail-handler.js';
import { handleGitHubWebhook } from './github-handler.js';
import { handleApi } from './api.js';

const CORS_ORIGIN = 'https://dashboard.chitty.cc';

const CORS = {
  'access-control-allow-origin': CORS_ORIGIN,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

function authenticate(request: Request, env: Env): Response | null {
  if (!env.API_TOKEN) return null;
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) {
    return json({ error: 'Missing or invalid Authorization header' }, 401);
  }
  if (auth.slice(7) !== env.API_TOKEN) {
    return json({ error: 'Invalid token' }, 401);
  }
  return null;
}

export default {
  async tail(events: TraceEvent[], env: Env): Promise<void> {
    await handleTail(events, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
      }

      // Health check (public)
      if (path === '/health') {
        return json({
          status: 'ok',
          service: env.SERVICE_NAME,
          version: env.SERVICE_VERSION,
          timestamp: new Date().toISOString(),
        });
      }

      // Root info (public)
      if (path === '/') {
        return json({
          service: 'chittytrack',
          description: 'Centralized observability for ChittyOS',
          endpoints: [
            'GET /health',
            'GET /api/v1/workers',
            'GET /api/v1/errors?worker=&date=&limit=',
            'GET /api/v1/stats',
            'POST /api/v1/github',
          ],
        });
      }

      // GitHub webhook (authenticated via HMAC signature)
      if (path === '/api/v1/github' && request.method === 'POST') {
        return handleGitHubWebhook(request, env);
      }

      // API endpoints (authenticated via Bearer token)
      if (path.startsWith('/api/v1/')) {
        const authErr = authenticate(request, env);
        if (authErr) return authErr;
        return handleApi(path, request, env);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      console.error('Unhandled error:', err);
      return json({ error: 'Internal server error' }, 500);
    }
  },
};
