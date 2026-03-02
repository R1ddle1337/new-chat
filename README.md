# new-chat MVP

Web-only chat app (OpenAI-like UI) with a Fastify gateway, Next.js frontend, Postgres history, Redis rate limits/sessions, and MinIO-backed image upload for vision requests.

## Features

- Cookie-based auth (`httpOnly` session cookie) for same-origin web usage.
- Cloud-synced chat history in Postgres (`threads` + `messages`).
- BYOK per user (encrypted at rest with AES-256-GCM via `KEY_ENCRYPTION_KEY`).
- Multi-provider routing:
  - `openai` (`https://api.openai.com/v1`)
  - `grok2api` (`https://gapi.lyxnb.de5.net/v1`)
- OpenAI-compatible API surface in the gateway:
  - `POST /v1/responses` (primary, supports `stream: true` SSE proxy)
  - `POST /v1/chat/completions` (compat)
  - `GET /v1/models` (merged, 60s cache)
  - `POST /v1/files` (multipart image upload)
- Vision flow: uploaded images are stored privately in MinIO, then gateway fetches image bytes and injects data URLs into upstream request payload.
- Security controls:
  - frontend never calls upstream directly
  - strict `Origin` check on all state-changing requests
  - Redis rate limiting for auth + `/v1/*`
  - structured audit logs (without key or prompt leakage)

## Monorepo Layout

- `apps/gateway` - Fastify + TypeScript gateway
- `apps/web` - Next.js TypeScript web app (login/settings/chat + API proxy)
- `infra/compose` - Docker Compose stack

## Database

Gateway migrations are plain SQL files in `apps/gateway/migrations` and are auto-applied on startup via a small migration runner.

Tables:

- `users`
- `providers`
- `user_provider_keys`
- `threads`
- `messages`
- `files`
- `audit_events`
- (`schema_migrations` support table)

## Quick Start (Docker)

1. Start everything:

```bash
cd infra/compose
docker compose up --build
```

2. Open app:

- Web: `http://localhost:3000`
- Gateway health: `http://localhost:3001/healthz`
- MinIO console: `http://localhost:9001` (`minioadmin` / `minioadmin`)

## Local Dev (without Docker)

1. Install dependencies:

```bash
pnpm -r install
```

2. Start Postgres, Redis, MinIO (from compose or local installs).

3. Set env vars (copy from `.env.example`).

4. Run apps:

```bash
pnpm --filter @new-chat/gateway dev
pnpm --filter @new-chat/web dev
```

## Smoke Test Steps

1. Register in `/login`.
2. Open `/settings`:
   - add provider key for `openai` or `grok2api`
   - optionally set default provider/model
3. Open `/chat`:
   - send a text prompt
   - optionally attach an image and send
4. Verify history:
   - refresh page and reopen thread (messages persist)
5. Verify gateway APIs manually (optional):

```bash
curl -i http://localhost:3001/me
```

(Expect `401` without session cookie)

## API Summary

Gateway routes:

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `POST /me/keys`
- `GET /me/keys`
- `POST /me/provider`
- `GET /me/threads`
- `GET /me/threads/:threadId/messages`
- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/files`

## Notes

- `KEY_ENCRYPTION_KEY` is mandatory.
- `APP_ORIGIN` must match the web origin used by browser clients.
- `SECURE_COOKIES=true` should be enabled behind HTTPS.
