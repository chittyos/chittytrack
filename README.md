![ChittyOS](https://img.shields.io/badge/ChittyOS-service-6366F1?style=flat-square)
![Tier](https://img.shields.io/badge/tier-3%20operational-3730A3?style=flat-square)

# ChittyTrack

Centralized observability for ChittyOS. Receives logs from all Cloudflare Workers via Tail Workers and GitHub events via webhooks.

## Quick Start

```bash
npm install
npm run dev
npm run deploy:production
curl -sf https://track.chitty.cc/health | jq .
```

## How It Works

1. Every ChittyOS Worker adds `[[tail_consumers]] service = "chittytrack"` to its `wrangler.toml`
2. Cloudflare automatically streams all logs to ChittyTrack's `tail()` handler
3. ChittyTrack writes to Analytics Engine (queryable) and R2 (archive)
4. GitHub org webhook sends CI/deploy/check events to `/api/v1/github`
5. Errors are forwarded to `chittyagent-resolve` for auto-remediation

## Documentation

See [CLAUDE.md](./CLAUDE.md) for development guide.
