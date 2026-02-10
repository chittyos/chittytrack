import type { Env, TraceEvent } from './types.js';
import { handleTail } from './tail-handler.js';
import { handleGitHubWebhook } from './github-handler.js';
import { handleApi } from './api.js';

export default {
  async tail(events: TraceEvent[], env: Env): Promise<void> {
    await handleTail(events, env);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
        },
      });
    }

    // Health check
    if (path === '/health') {
      return json({
        status: 'ok',
        service: env.SERVICE_NAME,
        version: env.SERVICE_VERSION,
        timestamp: new Date().toISOString(),
      });
    }

    // GitHub webhook receiver
    if (path === '/api/v1/github' && request.method === 'POST') {
      return handleGitHubWebhook(request, env);
    }

    // API endpoints
    if (path.startsWith('/api/v1/')) {
      return handleApi(path, request, env);
    }

    // Root
    if (path === '/') {
      return json({
        service: 'chittytrack',
        description: 'Centralized observability for ChittyOS',
        endpoints: [
          'GET /health',
          'GET /api/v1/workers',
          'GET /api/v1/errors?worker=&date=&limit=',
          'GET /api/v1/stats',
          'GET /api/v1/query',
          'POST /api/v1/github',
        ],
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  });
}
