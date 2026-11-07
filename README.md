# Insight

**Read-only, AI-assisted pull request review for GitHub.** Insight combines deterministic AST analysis with LLM review, and only surfaces findings it can tie to an exact location and evidence in the diff.

> **Status:** v0.1.0. The backend (API, analysis, AI adapter, persistence, tests) is implemented. The React frontend is a labeled prototype; wiring it to the API is the next milestone.

<!-- Add: docs/img/findings-screen.png (screenshot of FindingsScreen) -->
<!-- Add: docs/img/architecture.png (diagram from the Architecture section) -->

## Why it exists

Reviewers miss risky changes in large pull requests, and LLM reviewers invent issues. Insight treats the model as an untrusted component: static analysis produces reproducible findings, the LLM adds context-aware ones, and the server validates every source reference before anything reaches the user.

## How it works

1. **Snapshot**: fetch the PR's changed files and related context from GitHub (bounded by file, byte and time limits).
2. **Parse and analyze**: `@babel/parser` builds ASTs for JS/JSX/TS/TSX; a structural analyzer applies a versioned rule catalog.
3. **Review**: a provider adapter sends redacted, size-bounded context to an allowlisted LLM and requests schema-constrained JSON.
4. **Validate**: findings are rejected unless their path, line range and evidence text match the supplied changed files; findings that overlap changed lines are kept, and each gets a keyed HMAC fingerprint so recurring issues can be tracked across reviews.
5. **Propose patches (optional)**: a patch proposal is generated, applied mechanically, and re-parsed to confirm it is still syntactically valid. Insight never pushes to GitHub.

### Deterministic rules

| Rule | Category | Detects |
|---|---|---|
| JS001 | correctness | Syntax / parse errors |
| SEC001 | security | Dynamic code execution |
| SEC002 | security | Possible hardcoded secrets |
| SEC003 | security | Disabled TLS certificate validation |
| API001 | breaking change | Removed exports |
| API002 | breaking change | Changed function signatures |

## Architecture

Modular monolith: one Express application with domain modules and explicit service boundaries.

```
backend/src
├── ai/          provider adapter, finding schema, model allowlist, secret redaction
├── analysis/    Babel parser wrapper, rule catalog, structural analyzer
├── auth/        GitHub OAuth, session/token handling, repository access checks
├── reviews/     snapshot, context selection, review service, finding validator
├── patches/     patch proposals, unified-diff handling
├── repositories/ selection and PR listing
├── webhooks/    signed GitHub webhook receiver
├── retention/   data-retention and uninstall-grace lifecycle
├── security/    CSRF, sessions, AES-256-GCM token vault
├── models/      Mongoose models
└── config/      Zod-validated environment (fails closed)
```

Design docs: [`docs/architecture.md`](docs/architecture.md), [`docs/api-contract.md`](docs/api-contract.md), [`docs/technology-stack.md`](docs/technology-stack.md).

## Tech stack

| Layer | Technology |
|---|---|
| Runtime / API | Node.js 24+, Express 5, versioned REST API (`/api/v1`) |
| Database | MongoDB, Mongoose, `connect-mongo` sessions |
| Code analysis | `@babel/parser` (AST) |
| Validation | Zod (environment, requests, provider responses) |
| AI | Provider adapter: OpenAI, Anthropic, Gemini, Groq (explicit model allowlist) |
| Security | Helmet, `express-rate-limit`, CSRF tokens, `express-session` |
| Frontend | React 19, Vite |
| Testing | Jest, Supertest, ESLint, custom evaluation harness |

## Security and reliability decisions

- Repository code, comments and PR text are treated as untrusted data in prompts; the model gets no tools, secrets or write access.
- Secrets are redacted from source before it is sent to a provider.
- OAuth tokens are encrypted at rest with AES-256-GCM; sessions use `httpOnly`, `sameSite=lax` cookies; state-changing routes require a CSRF token.
- Webhook payloads are verified with an HMAC signature using a timing-safe comparison.
- Request bodies, rate limits, file counts and byte sizes are bounded; invalid configuration stops the server at startup.
- Full source is held only for the active operation and is not persisted.

## Testing and evaluation

- **59 backend tests** across 15 files (Jest + Supertest) covering auth, webhooks, the analyzer, finding validation, patch service, provider adapters, API contract and a MongoDB integration suite.
- **Performance check:** 41 files totaling 20 MiB were parsed and analyzed in 145 ms (Node.js v26.10.0, macOS arm64). This measures in-process parsing only, not GitHub, MongoDB or LLM latency.
- **Evaluation baseline** (`npm run evaluate`): dataset `insight-eval-v1`, 10 hand-authored cases (7 positive, 3 clean). All 7 expected findings were found with no false positives on clean cases. This is a small controlled baseline, **not** a claim about real-world precision or recall.

## Getting started

Requirements: Node.js 24+, a MongoDB instance.

```bash
cd backend
npm install
cp .env.example .env     # set SESSION_SECRET, TOKEN_ENCRYPTION_KEY, FINGERPRINT_HMAC_KEY, MONGODB_URI
npm test
npm run lint
npm run evaluate
npm run dev              # API on http://localhost:4000, health at /api/v1/health
```

GitHub and LLM credentials are only needed for live GitHub routes and AI review; parser, unit and evaluation work run without them. See [`backend/README.md`](backend/README.md) for GitHub App setup.

## Roadmap

- [ ] Connect the React frontend to the backend API
- [ ] Expand the labeled evaluation dataset using controlled repositories
- [ ] Measure end-to-end review latency in an integration environment
- [ ] Demo GIF and deployed instance

## License

<!-- choose a license (MIT is typical for portfolio projects) -->
