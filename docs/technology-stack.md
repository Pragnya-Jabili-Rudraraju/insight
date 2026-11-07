# Insight Technology Stack

## Status

This document records the approved V1 technology choices. The initial modular-monolith backend implementation is in `backend/`; production integrations require local credentials and service configuration.

## Stack

| Area | Technology | Purpose and boundaries |
|---|---|---|
| Runtime | Node.js | Runs the backend application and its JavaScript modules. |
| HTTP framework | Express.js | Hosts the versioned REST API, authentication callbacks, webhook receiver, and middleware. |
| Language | JavaScript | Use JavaScript throughout the backend. Do not introduce TypeScript into backend code. |
| Database | MongoDB | Stores review executions, findings, patch proposals, selected-repository metadata, and historical risk records. |
| ODM | Mongoose | Defines document models, validation boundaries, references, and indexes. |
| Code parser | @babel/parser | Parses JS, JSX, TS, and TSX source into ASTs for bounded structural analysis. It is a parser, not a compiler or complete type checker. |
| Input and output validation | Zod | Validates environment configuration, HTTP request bodies, provider configuration, and structured provider responses. |
| AI integration | LLM APIs | Named supported providers are called through a provider adapter. No arbitrary custom endpoints are accepted. |
| Testing | Jest and Supertest | Jest runs backend unit/integration tests; Supertest exercises Express request/response behavior. Repository fixture code is analyzed as data and is never executed. |
| API architecture | REST | Versioned JSON API contracts are defined before backend implementation. |
| Overall architecture | Modular Monolith | One deployable Node/Express application with independently organized domain modules and explicit service boundaries. |

## Parser boundaries

The parser creates Babel ASTs and reports syntax diagnostics. JSX and TypeScript syntax are enabled by file type. Parsing supports structural rules such as imports/exports, call relationships, selected function signatures, and potentially dangerous syntax patterns.

Parsing does not execute source, build a compiler, perform project-aware semantic type checking, or prove that a heuristic pattern is exploitable. Parser and AST results remain tied to the exact repository, base SHA, head SHA, path, and content hash.

The Babel parser supports JSX and TypeScript through parser plugins; implementation will pin a compatible package version and configure plugins deliberately. See the official [Babel parser documentation](https://babel.dev/docs/babel-parser).

## Provider boundary

Provider-specific request and response handling belongs behind a JavaScript adapter interface. Configuration identifies an enabled named provider, model, timeout, output limit, attempt limit, and prompt/schema version. Provider credentials are secret references and are never stored in review records or logs.

The provider adapter does not grant the model tools, repository access, code execution, or permission to mutate GitHub. The server validates the structured response and every source reference.

## Testing boundary

Tests exercise Insight modules, API contracts, parser behavior, lifecycle transitions, security checks, and controlled evaluation fixtures. Jest and Supertest tests must not execute source code from analyzed repositories. Tests may pass fixture source strings to the parser and assert on the AST and resulting analysis data.

## Configuration

Configuration is validated at process startup with Zod. Invalid or unsafe configuration fails closed. Explicit settings include:

- Analysis and review file, byte, context, and timeout limits.
- GitHub App identity, callback, webhook and selected-repository configuration.
- Encryption key/secret references and session settings.
- Enabled named provider and explicitly allowlisted model, timeout, response-size, and attempt limits. The current structured-output model allowlist is OpenAI `gpt-4o-mini`, Anthropic `claude-sonnet-4-6`, and Gemini `gemini-3.8-flash`; changing it requires updating `backend/src/ai/supported-models.js` and its configuration tests.
- Maximum repository, findings, history-page, and per-source history aggregation result counts.
- Analyzer, prompt, fingerprint and evaluation dataset versions.
- Connected-repository and post-uninstall retention periods.

The supported Node.js major version and exact package versions are not fixed in this architecture document. They will be selected and recorded in the lockfile during the implementation setup after compatibility review.

## Explicit exclusions

V1 does not add Python, LangChain, a vector database, Redis, a queue, microservices, an agent framework, a custom compiler, or arbitrary provider endpoints. Worker threads are not part of the initial stack; they may be introduced only if the required maximum-input performance test demonstrates a need.

## Official references

- [Node.js](https://nodejs.org/)
- [Express.js](https://expressjs.com/)
- [MongoDB](https://www.mongodb.com/docs/)
- [Mongoose](https://mongoosejs.com/docs/)
- [Babel parser](https://babel.dev/docs/babel-parser)
- [Zod](https://zod.dev/)
- [Jest](https://jestjs.io/docs/getting-started)
- [Supertest](https://github.com/ladjs/supertest)
