# Insight backend

JavaScript modular monolith for Insight's read-only GitHub pull request review API. The service uses Node.js, Express, MongoDB/Mongoose, Babel Parser, Zod, named LLM provider adapters, Jest, and Supertest.

## Local setup

Requirements: Node.js 24 or newer and a MongoDB instance.

1. Run `npm install` in this directory.
2. Copy `.env.example` to `.env` and set a random `SESSION_SECRET` of at least 32 characters. Generate independent 32-byte hex values for `TOKEN_ENCRYPTION_KEY` and `FINGERPRINT_HMAC_KEY`.
3. Set `MONGODB_URI`. GitHub and LLM credentials are not needed for parser, unit, or evaluation work. Live GitHub routes require a configured GitHub App and MongoDB; AI review also requires a supported provider key. Gemini is configured with `LLM_PROVIDER=gemini`, `LLM_MODEL=gemini-3.8-flash`, and `GEMINI_API_KEY`.
4. Run `npm test`, `npm run lint`, and `npm run evaluate`.
5. Run `npm run dev` to start the API on port 4000. `/api/v1/health` is liveness; `/api/v1/health/ready` also checks MongoDB readiness.

Never commit `.env` or paste credentials into source code. Configure the GitHub App callback URL to match `GITHUB_CALLBACK_URL`, use GitHub.com, set the App webhook URL to `/api/v1/webhooks/github`, and provide only the approved read permissions. Keep the configured GitHub account ID fixed through `GITHUB_ALLOWED_USER_ID`.

## Configuration

`src/config/env.js` validates the supported provider names, model settings, secrets, and analysis/resource limits at startup. Environment names and default bounds are in `.env.example` and `docs/architecture.md`. Source and diff data are bounded and held for an active operation; full source is not persisted.

## API and modules

The API contract is in `../docs/api-contract.md`. Module responsibilities and lifecycle/data-retention decisions are in `../docs/architecture.md`. The API is mounted below `/api/v1`; it does not expose a GitHub write operation.

## Validation commands

- `npm test -- --runInBand` — unit and HTTP-boundary tests, including a maximum-input analyzer performance check. Supertest requires localhost socket access.
- `npm run lint` — ESLint checks for source and tests.
- `npm run evaluate` — emits metrics for the separate controlled dataset in `evaluation/datasets/v1.json`.

The small evaluation fixture set is a baseline for development, not evidence of production precision or recall. No threshold is set from it. The performance fixture measures in-process parsing and structural analysis only; GitHub latency, MongoDB, and provider time require an integration environment to assess the full 60-second review budget.

## Current integration boundary

The backend modules and deterministic tests are implemented. Live GitHub authorization/webhooks, MongoDB persistence, and LLM calls require a configured GitHub App, MongoDB, secrets, and (for AI) a supported provider key. Gemini uses a fixed Google Generative Language API host and structured JSON output; never send private repository code to a provider unless you accept that provider’s data terms. The existing frontend remains a clearly labeled prototype; API integration is a separate milestone.
