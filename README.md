# ModelHub Console

Local-first prototype for an AI provider gateway: encrypted user API keys, multi-model chat, usage tracking, prompt templates, knowledge base QA, batch jobs, and audit logs.

## Run Locally

```bash
npm start
```

In this Codex desktop workspace, Node is available here:

```powershell
& 'C:\Users\king\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' server.js
```

Open:

```text
http://localhost:5173
```

## Production Stack

Recommended MVP stack:

- Auth: Supabase Auth
- Core data: Supabase PostgreSQL
- ORM: Prisma
- Vectors: Supabase pgvector first, Qdrant/Pinecone later if needed
- Files: Cloudflare R2
- Cache/rate limits: Upstash Redis

## Setup

1. Copy `.env.example` to `.env`.
2. Generate `CREDENTIAL_MASTER_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

3. Fill Supabase, R2, and Upstash values as needed.
4. Install dependencies:

```bash
npm install
```

5. Generate Prisma client and migrate:

```bash
npm run db:generate
npm run db:migrate
```

6. Run `sql/supabase_rls.sql` in the Supabase SQL editor.

## Supabase Auth

Set these in `.env`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AUTH_JWKS_URL`
- `AUTH_JWT_ISSUER`

The homepage login box will use Supabase Auth and send the access token to the backend automatically as soon as `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set.

Use `DATA_BACKEND=prisma` when you want database-backed multi-user isolation for private data instead of the local JSON demo store.

## Backends

`DATA_BACKEND=local` keeps the current JSON demo database:

```text
data/db.json
```

`DATA_BACKEND=prisma` enables Supabase token validation and Prisma storage boundaries. API credentials, audit logs, chat history, and usage records are stored in Supabase PostgreSQL through Prisma and scoped to the signed-in user organization. Chat message bodies are encrypted at rest with AES-256-GCM before they are written to the database. Other modules such as prompts, knowledge bases, and batch jobs still use the local demo store while the Prisma adapter is being expanded.

## Security

- User API keys are never stored in plaintext.
- Secrets use AES-256-GCM with server-side master key, AAD, and `keyVersion`.
- Production refuses to start without `CREDENTIAL_MASTER_KEY`.
- API key fingerprints use HMAC, not raw SHA-256.
- Logs and error messages are scrubbed for key-like values.
- `/api/privacy/classify` classifies and redacts sensitive input before model routing.
- `api_credentials` has no user-facing RLS policies; access it only from backend service credentials.

## New API Endpoints

- `GET /api/security/status`: backend and privacy configuration status
- `POST /api/privacy/classify`: returns privacy level and redacted text
- `POST /api/chat`: applies tenant context, rate limit, privacy classification, provider routing, and local fallback

## Provider Routing

Set platform-owned keys to enable live external calls:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GEMINI_API_KEY=
```

If a provider key is absent, chat falls back to the local simulated response. If privacy policy blocks a provider for the detected data class, the backend returns a policy-blocked response instead of sending the content out.
