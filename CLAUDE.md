---
uri: chittycanon://docs/tech/spec/chittytrack
namespace: chittycanon://docs/tech
type: spec
version: 1.0.0
status: CERTIFIED
registered_with: chittycanon://core/services/canon
title: ChittyTrack Development Guide
author: ChittyOS Team
created: 2026-02-09T00:00:00Z
modified: 2026-02-09T00:00:00Z
visibility: PUBLIC
tags: [observability, logging, metrics, tail-worker]
---

# ChittyTrack

Centralized observability for ChittyOS. Receives logs from all Cloudflare Workers via Tail Workers and GitHub events via webhooks.

## Architecture

ChittyTrack is a dual-mode Cloudflare Worker:
- **Tail handler**: Receives `TraceItem` events from all producer workers
- **Fetch handler**: Exposes REST API for querying logs, errors, and stats

Data flows:
- Hot data → Analytics Engine (`chittytrack_logs` dataset) for SQL queries
- Cold data → R2 (`chittytrack-logs` bucket) for error archives
- State → KV (`TRACK_STATE`) for worker last-seen and counters

## Development

```bash
npm install
npm run dev        # Local development
npm run deploy:production  # Deploy to track.chitty.cc
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /health | Standard health check |
| GET | /api/v1/workers | List tracked workers + last-seen |
| GET | /api/v1/errors | Recent errors (filter by ?worker=&date=&limit=) |
| GET | /api/v1/stats | Aggregate stats across all workers |
| GET | /api/v1/query | Analytics Engine SQL query info |
| POST | /api/v1/github | GitHub webhook receiver |

## Adding a Producer

Add to any worker's `wrangler.toml`:
```toml
[[tail_consumers]]
service = "chittytrack"
```

Then redeploy that worker. ChittyTrack will start receiving its logs automatically.
