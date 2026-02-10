import type { Env, GitHubWebhookPayload } from './types.js';

export async function handleGitHubWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  // Verify webhook signature if secret is configured
  if (env.GITHUB_WEBHOOK_SECRET) {
    const signature = request.headers.get('x-hub-signature-256');
    if (!signature) {
      return json({ error: 'Missing signature' }, 401);
    }
    const body = await request.clone().text();
    const valid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
    if (!valid) {
      return json({ error: 'Invalid signature' }, 401);
    }
  }

  const eventType = request.headers.get('x-github-event') ?? 'unknown';
  const payload: GitHubWebhookPayload = await request.json();
  const repo = payload.repository?.full_name ?? 'unknown';

  // Write to Analytics Engine
  env.TRACK_ANALYTICS.writeDataPoint({
    doubles: [Date.now(), 0, 0],
    blobs: [
      `github:${repo}`,
      `${eventType}:${payload.action}`,
      '',
      '',
      summarizeGitHubEvent(eventType, payload),
    ],
    indexes: [`github:${repo}`],
  });

  // Handle specific event types
  const isFailure = detectGitHubFailure(eventType, payload);

  if (isFailure) {
    const errorDetail = {
      source: 'github',
      eventType,
      action: payload.action,
      repo,
      ...extractFailureDetails(eventType, payload),
      timestamp: Date.now(),
    };

    // Store in R2
    const date = new Date().toISOString().split('T')[0];
    const key = `github/${date}/${repo.replace('/', '-')}/${Date.now()}.json`;
    await env.TRACK_ARCHIVE.put(key, JSON.stringify(errorDetail));

    // Forward to resolve agent if bound
    if (env.RESOLVE_SERVICE) {
      try {
        await env.RESOLVE_SERVICE.fetch('https://resolve/api/v1/evaluate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            worker: `github:${repo}`,
            timestamp: Date.now(),
            outcome: 'github_failure',
            exceptions: [{ name: eventType, message: JSON.stringify(errorDetail), timestamp: Date.now() }],
            logs: [],
          }),
        });
      } catch {
        // Don't let resolve failures break webhook processing
      }
    }
  }

  return json({ received: true, event: eventType, action: payload.action });
}

function detectGitHubFailure(eventType: string, payload: GitHubWebhookPayload): boolean {
  if (eventType === 'workflow_run' && payload.action === 'completed') {
    return payload.workflow_run?.conclusion === 'failure';
  }
  if (eventType === 'deployment_status') {
    return payload.deployment_status?.state === 'failure';
  }
  if (eventType === 'check_run' && payload.action === 'completed') {
    return payload.check_run?.conclusion === 'failure';
  }
  return false;
}

function extractFailureDetails(eventType: string, payload: GitHubWebhookPayload) {
  if (eventType === 'workflow_run') {
    return {
      name: payload.workflow_run?.name,
      conclusion: payload.workflow_run?.conclusion,
      url: payload.workflow_run?.html_url,
    };
  }
  if (eventType === 'deployment_status') {
    return {
      state: payload.deployment_status?.state,
      description: payload.deployment_status?.description,
      url: payload.deployment_status?.target_url,
    };
  }
  if (eventType === 'check_run') {
    return {
      name: payload.check_run?.name,
      conclusion: payload.check_run?.conclusion,
      url: payload.check_run?.html_url,
    };
  }
  return {};
}

function summarizeGitHubEvent(eventType: string, payload: GitHubWebhookPayload): string {
  const summary: Record<string, string> = {
    event: eventType,
    action: payload.action,
  };

  if (payload.workflow_run) {
    summary.workflow = payload.workflow_run.name;
    summary.conclusion = payload.workflow_run.conclusion ?? 'pending';
  }
  if (payload.deployment_status) {
    summary.state = payload.deployment_status.state;
  }
  if (payload.check_run) {
    summary.check = payload.check_run.name;
    summary.conclusion = payload.check_run.conclusion ?? 'pending';
  }

  return JSON.stringify(summary);
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = `sha256=${Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  return signature === expected;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
