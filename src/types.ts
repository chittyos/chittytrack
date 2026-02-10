export interface Env {
  SERVICE_NAME: string;
  SERVICE_VERSION: string;
  TRACK_ANALYTICS: AnalyticsEngineDataset;
  TRACK_ARCHIVE: R2Bucket;
  TRACK_STATE: KVNamespace;
  GITHUB_WEBHOOK_SECRET?: string;
  RESOLVE_SERVICE?: Fetcher;
}

export interface TraceLog {
  timestamp: number;
  level: string;
  message: unknown[];
}

export interface TraceException {
  name: string;
  message: string;
  timestamp: number;
}

export interface TraceEvent {
  scriptName: string;
  outcome: string;
  eventTimestamp: number;
  event: {
    request?: {
      url: string;
      method: string;
    };
  };
  logs: TraceLog[];
  exceptions: TraceException[];
}

export interface GitHubWebhookPayload {
  action: string;
  workflow_run?: {
    id: number;
    name: string;
    conclusion: string | null;
    html_url: string;
    repository: { full_name: string };
  };
  deployment_status?: {
    state: string;
    description: string;
    target_url: string;
  };
  check_run?: {
    id: number;
    name: string;
    conclusion: string | null;
    html_url: string;
  };
  repository?: {
    full_name: string;
    name: string;
  };
}

export interface WorkerStats {
  worker: string;
  lastSeen: number;
  totalEvents: number;
  errorCount: number;
}

export interface ErrorEntry {
  worker: string;
  timestamp: number;
  outcome: string;
  exceptions: TraceException[];
  logs: TraceLog[];
  url?: string;
  method?: string;
}
