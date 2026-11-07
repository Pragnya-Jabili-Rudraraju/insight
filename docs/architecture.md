# Insight Backend Architecture

## Status and scope

This document describes the approved V1 architecture and the backend implementation now present in `backend/`. External GitHub, MongoDB, and LLM services still require local configuration before those integrations can run end to end.

Insight is a single-user AI code review and repository risk intelligence application. The backend is a modular monolith using Node.js, Express.js, JavaScript, MongoDB, and Mongoose. The API is REST. GitHub.com is the only GitHub host in V1.

There is no public signup, multi-user SaaS, queue, Redis, vector database, microservice, multi-agent system, repository code execution, or semantic type checker in V1.

## Module boundaries

The Express application is divided into modules with explicit responsibilities:

- **Auth and session:** GitHub App user authorization, OAuth state and PKCE, single configured GitHub identity, secure session lifecycle, logout, refresh, revocation, and reauthorization.
- **Installation and repository access:** selected GitHub App installation repositories, permission checks, repository listing, pull request listing, and webhook-driven installation state.
- **GitHub adapter:** GitHub.com API reads. It does not expose a general URL fetch facility and has no write operations.
- **Review orchestration:** creates an execution, advances and persists stage state, applies configured limits, and calls stage services synchronously in V1.
- **Snapshot service:** obtains immutable base/head revisions, file identities and content hashes, and checks revision consistency.
- **Context selection:** deterministically selects relevant unchanged source and records each selection reason and budget decision.
- **Deterministic analysis:** Babel parsing, parser diagnostics, structural artifacts, and versioned rules.
- **AI analysis:** named-provider adapter and structured candidate findings. V1 supports OpenAI, Anthropic, and Google Gemini through fixed provider hosts. AI is optional and isolated from the deterministic stage.
- **Finding validation:** validates file paths, sides, line ranges, evidence snippets and hashes against the pinned snapshot; records provenance, verification state, and disposition.
- **Historical risk service:** queries review executions and recurrence records; reports descriptive risk history with coverage and denominators.
- **Patch proposal service:** creates and validates separate, single-finding proposals tied to an expected head SHA and file hash.
- **Persistence and retention:** Mongoose models/indexes, 90-day connected detail retention, 30-day post-uninstall grace, deletion, and sanitized historical metadata.
- **Evaluation:** versioned controlled dataset and separate evaluation results.

The browser-facing APIs are versioned under `/api/v1` and documented in `docs/api-contract.md`. The current frontend prototype remains sample-only until a deliberate API integration milestone.

## Authentication and GitHub access

V1 uses GitHub.com and a GitHub App installed on explicitly selected repositories. The App requests minimum read-only permissions required for repository contents, pull request data, and metadata. Exact endpoint permission requirements are verified against GitHub’s current documentation during the GitHub integration milestone.

The configured single user authorizes the GitHub App. The server verifies the user’s stable GitHub account ID against the configured account. OAuth uses a one-time state value bound to the initiating browser session and PKCE using S256. The GitHub authorization request disables GitHub account signup. Expiring user access tokens and refresh tokens are handled; refresh tokens are encrypted at rest, rotated, and never exposed to the frontend.

Repository reads use user access tokens. A read is permitted only when the verified user, App permissions, App installation, and explicitly selected repository all allow it. Short-lived access tokens are held only as needed; refresh-token material is encrypted. Every repository and review API operation performs authorization.

The permission design follows GitHub’s fine-grained GitHub App model; endpoint-specific requirements must be checked before implementation. GitHub’s current documentation recommends requesting only needed permissions and describes the resource/permission intersection for App user tokens. See [choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) and [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user).

### Installation webhooks

The GitHub App webhook handles installation deletion, suspension, unsuspension, and selected-repository changes. The receiver verifies the raw request body using HMAC-SHA256 from X-Hub-Signature-256 with a constant-time comparison and deduplicates deliveries by X-GitHub-Delivery. Invalid signatures are rejected before parsing or acting on the payload. See [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

On verified deletion or suspension, repository access and refresh credentials are invalidated immediately. Source-derived evidence snippets and patch contents are deleted immediately. Sanitized metadata enters a 30-day grace period, then is purged unless the user reconnects within that period and chooses to retain it. A revoked or expired token also fails closed; the user must reauthorize. Webhook handling is supplemented by authorization checks and GitHub API error handling so access does not rely on webhook delivery alone.

## Snapshot consistency

Each review snapshot is identified by GitHub repository ID, pull request number, base SHA, and head SHA.

1. Read and record the current PR base/head SHAs before retrieval.
2. Fetch the tree, changed-file list, diff and required source by immutable commit/blob identifiers.
3. Verify that each fetched file belongs to the pinned tree and record blob SHA/content hash.
4. Re-read the PR SHAs after source retrieval.
5. Immediately before finalizing and persisting accepted results, re-read and compare the current base/head SHAs again.

If either SHA differs at any consistency check, the execution becomes stale and results are not finalized as current. Candidate evidence from an inconsistent run is not returned as completed or partial results. Patch proposals are checked again against the expected head SHA and file hash immediately before being offered.

## Context selection and limits

The context-selection service considers unchanged source, imports, callers, models, middleware, route relationships, and tests using parser-derived structural relationships and deterministic selection rules. It records:

- selected or skipped file path and immutable source reference;
- content hash, size, side or commit reference;
- reason code and a concise selection explanation;
- selection rank and total context budget used.

Example reason codes include imports_changed_module, calls_changed_export, model_used_by_changed_code, middleware_for_changed_route, and matching_test. Selection uses deterministic ranking and tie-breaking; there are no embeddings or vector search.

Initial configurable limits:

| Area | Limit |
|---|---:|
| Repository analysis candidate files | 1,000 |
| Total repository source/config data | 20 MiB |
| Maximum parsed file | 500 KiB |
| PR changed files | 50 |
| PR diff | 500 KiB |
| Selected context | 100 KiB |
| Review operation | 60 seconds |

The effective settings are stored in each execution. Skipped files, truncated context, parse failures, and incomplete stages are reported clearly.

## Deterministic and AI-assisted analysis

These are distinct analysis stages. Both produce candidates with preserved source and check status; one source is never rewritten as another.

### Initial deterministic rules

The first small, versioned rule set includes:

- JavaScript/TypeScript parser diagnostics.
- Dangerous dynamic execution patterns such as eval and new Function.
- Potential hardcoded secrets, with secret redaction in evidence, persistence and logs.
- Clearly identifiable unsafe TLS configurations.
- Selected structural import/export and function-signature changes.

These rules flag patterns for review. A pattern match alone does not establish exploitability.

Babel Parser generates ASTs for JavaScript and supported JSX/TypeScript syntax; it is not a compiler and does not perform complete semantic type checking. Repository code is parsed as data and is never executed.

### AI-assisted analysis

AI is routed through an adapter for named supported providers only; arbitrary custom endpoints are not permitted. Provider/model, prompt and structured-output schema versions are recorded for each execution. PR text, comments, documentation and source are untrusted input. The model has no tools, secrets, repository credentials, or code-execution capability.

Provider output is schema-validated and then checked against the pinned source. Invalid paths, sides, line ranges or snippets are rejected or retained as rejected candidates with a reason. If AI fails but deterministic results remain usable, the execution is partial and keeps those deterministic results.

## Finding provenance and verification

Every candidate finding records:

- execution ID and exact repository/PR/base/head revision;
- origin: deterministic rule or AI provider, with rule ID or provider/model reference;
- disposition: candidate, accepted or rejected, with rejection reason;
- check status: unverified, evidence checked, or rule checked;
- category, severity, path, side, line range, explanation, suggested improvement and test guidance;
- evidence snippet/reference, source blob SHA and content hash;
- optional reported or calibrated confidence data, kept separate from verification.

User-facing labels should be plain language. A checked source location does not mean the issue was reproduced. V1 does not execute repository code, so a reproduced status is not used.

## Review lifecycle

An execution is persisted before external retrieval and advances through explicit stages:

created → authorizing → fetching_snapshot → verifying_snapshot → selecting_context → deterministic_analysis → ai_analysis when enabled → validating → final_snapshot_check → persisting → completed, partial, failed, or stale.

- **Completed:** every enabled stage completed; zero findings is a valid completed result.
- **Partial:** usable results exist, but an analysis limit, parser issue, or optional AI failure prevented complete analysis.
- **Failed:** no usable result could be produced.
- **Stale:** the PR revisions changed; results are not finalized for the new revision.
- **Cancelled:** reserved for a future supported cancellation flow.

Timeout is recorded as a failure reason. It becomes partial only if usable results were safely persisted; otherwise it is failed. Each stage records status, timestamps, warnings, and reason codes.

## Data model, indexes and retention

Executions, findings, and patch proposals are separate collections. Per-file records are kept separate to avoid oversized documents. Full repository source is not retained by default.

| Collection | Purpose | Key indexes |
|---|---|---|
| GitHubCredential | Single configured GitHub account ID, encrypted refresh token, expiry/refresh/revocation state | Unique account ID; credential status |
| InstallationRepository | Installation ID, selected repository IDs, permission and active/suspended state | Unique installation/repository; status |
| ReviewExecution | Snapshot SHAs, lifecycle/stage state, timestamps, config and version records, warnings/coverage | Unique execution ID; repository/PR/createdAt; repository/PR/base/head/createdAt |
| SourceSnapshotFile | Path/side/blob SHA/content hash/size and retrieval status; no full source by default | Unique execution/side/path; repository/commit/path |
| AnalysisArtifact | Parser diagnostics and structural import/export/call relationships tied to file hash | Unique execution/path |
| ContextManifest | Selected/skipped context, reason codes, ranks, and byte budgets | Execution/selected; execution/reason |
| Finding | Provenance, check status, disposition, location, evidence references, content and fingerprint reference | Unique execution/finding key; execution/severity; execution/path/start line; repository/fingerprint |
| HistoricalOccurrence | Sanitized fingerprint, category/rule, severity, origin/check state, time and execution/coverage reference | Repository/fingerprint version/hash/date; repository/date |
| PatchProposal | Finding/execution/snapshot, expected head SHA/file hash, original/proposed code, unified diff and validation result | Execution/finding/date; repository/PR/head/path |
| EvaluationRun | Dataset version, analyzer/prompt/provider/model versions, metrics and run metadata | Dataset/date; analyzer/prompt/date |

### Retention

- Full private source files are held in memory only for the active review and are not stored by default.
- Connected repositories use a configurable **90-day default** for detailed findings, evidence snippets, and patch proposal contents.
- Sanitized execution and recurrence metadata is retained while the repository remains connected, subject to explicit deletion.
- On App uninstall or suspension, access and credentials are invalidated immediately; evidence snippets and patch contents are deleted immediately. Sanitized metadata remains for **30 days**, then is purged unless the user reconnects during that period and chooses to retain it.
- Explicit repository-history deletion purges executions, findings, evidence, fingerprints, patches, and history.

Sanitized metadata excludes source files, snippets, raw evidence, patch contents, and raw prompts. It may include repository/PR/revision IDs, timestamps, statuses, counts, coverage, version/config identifiers, and repository-scoped keyed fingerprints. The retention and deletion behavior is documented for users.

## Historical risk intelligence

Historical risk intelligence is core V1. It summarizes prior reviews and recurring findings descriptively; it does not predict future failures or make unsupported risk-score claims.

A finding fingerprint is versioned and based on rule/category, affected symbol or code location, and normalized evidence. It is not based solely on a path, line number, or title. A repository-scoped keyed hash limits exposure of normalized source-derived fingerprint inputs.

- **Confirmed match:** a deterministic fingerprint match with checked evidence on the relevant executions.
- **Possible AI-assisted match:** a provider-suggested semantic match, shown separately and never automatically merged or counted as confirmed.

History includes coverage denominators: reviewed PR count, changed files analyzed, completed/partial runs, verified findings and hypotheses. Sparse history and partial reviews are explicitly marked. Fingerprint algorithm changes are versioned; unlike versions are not silently merged.

History endpoints initially aggregate persisted records on demand. Materialized aggregates are considered only if measured query performance requires them.

## Patch proposals

Patch proposals are separate records associated with one finding and one execution. Each is bound to the expected head SHA, file path, and file hash. Before returning a proposal, the service re-checks that the current PR still has the expected head and that the file hash matches. A mismatch marks the proposal stale and prevents it from being offered as current.

The backend stores original/proposed code, a unified diff artifact, and a plain validation result. The frontend may show original and proposed code without displaying the unified diff. Proposals can be copied or downloaded; no GitHub write route exists.

## API contract

The route contract is documented in `docs/api-contract.md`. Routes are versioned under `/api/v1`:

- GET `/health` and `/health/ready` — liveness and MongoDB readiness.
- GET `/auth/github/start`, `/auth/github/callback`, `/session`, `/csrf` — GitHub authorization and session/CSRF state.
- POST `/auth/github/disconnect` and `/session/logout` — revoke GitHub credentials or end the local session.
- GET `/repositories` and PUT `/repositories/{repositoryId}/selection` — list installed repositories and explicitly select/deselect them.
- GET `/repositories/{repositoryId}/pull-requests` and `/pull-requests/{number}` — list and inspect pull requests.
- POST `/reviews`; GET `/reviews/{executionId}` and `/reviews/{executionId}/findings` — synchronous review and result retrieval.
- GET `/reviews/{executionId}/findings/{findingId}/concept` — optional concept learning content.
- GET and DELETE `/repositories/{repositoryId}/history` — history and explicit deletion.
- POST `/reviews/{executionId}/findings/{findingId}/patch-proposals`; GET `/patch-proposals/{proposalId}` — revision-bound proposal creation and retrieval.
- POST `/webhooks/github` — signed GitHub App webhook deliveries.

All state-changing application requests require session protection and CSRF validation. Errors use stable codes, plain-language messages, retryability, and a request ID. Stale revision, permission, reauthorization, limit, partial, and server error outcomes are distinct.

V1 review requests run synchronously and return the terminal execution resource. The response shape allows a future running state and polling without changing the resource schema if background execution is later justified.

## Security and resource protection

- **SSRF:** only GitHub.com and named provider hosts are reachable; PR-supplied URLs are never fetched; redirects are rejected or revalidated; private, loopback, link-local, and metadata IP ranges are blocked.
- **Resource exhaustion:** enforce all file/byte/context limits, request body limits, bounded pagination/concurrency, upstream aborts, and the 60-second operation budget.
- **Parsing:** start with bounded in-process parsing. A maximum-allowed-input performance test measures wall time, memory, and event-loop delay. Introduce worker threads only if these measurements justify them; failure to meet the performance gate must be resolved before V1 acceptance.
- **Credentials:** encrypt refresh tokens, keep secrets out of logs/database result documents, use secure HttpOnly/SameSite cookies, rotate sessions, validate OAuth state/PKCE, and document key rotation.
- **Webhook security:** validate HMAC-SHA256 over the raw body with constant-time comparison, reject invalid signatures, and deduplicate delivery IDs.
- **Prompt injection:** treat repository content as untrusted; provide no model tools, secrets, or execution environment; schema-check and source-check all outputs.
- **Dependencies:** use a lockfile, minimal packages, vulnerability scanning, and reviewed updates.

## Evaluation

The evaluation dataset is dedicated, versioned, and separate from production history. It includes labeled defects and clean changes. Deterministic and AI results are measured separately.

Metrics:

- Precision = true positives / reported positives.
- Recall = true positives / labeled positives.
- False-positive rate = false positives / labeled negatives, plus false positives per PR.
- Evidence accuracy = references matching pinned path, side, range and snippet / all evidence references; human labels judge whether the evidence supports the claim.
- Patch validity = proposals tied to expected revision/file hash that apply cleanly and parse statically / proposals evaluated.

Patch validity is mechanical and does not prove behavioral correctness. Repository code is not executed during evaluation. Establish baselines on the versioned dataset before setting final precision/recall thresholds.

## Technology decisions

Backend implementation uses Node.js, Express.js and JavaScript; MongoDB with Mongoose; Babel Parser; Zod; named LLM APIs; Jest and Supertest; REST; and a modular monolith. See the companion technology-stack document for boundaries, official references, and configuration rules.

## Milestones and acceptance criteria

1. **Backend foundation and contracts**
   - Acceptance: the application starts only with valid configuration and MongoDB; versioned routes have stable response/error shapes; execution records include exact snapshot/config/version metadata; credentials are excluded from results and logs; unit and request tests pass.

2. **GitHub App identity, selected repository access, credentials and webhooks**
   - Acceptance: GitHub.com only; single configured account; OAuth state and PKCE S256; explicit selected repositories; minimal read-only permissions; encrypted refresh-token lifecycle; signed, deduplicated deletion/suspension/repository-selection webhooks; access is invalidated and data-retention actions occur as specified.

3. **Snapshot retrieval and context selection**
   - Acceptance: SHA checks before retrieval, after retrieval, and immediately before finalization; stale snapshots never finalize; files are immutable-revision fetched; context reasons and budgets are recorded; skipped work is reported.

4. **Deterministic structural analyzer**
   - Acceptance: initial rules are versioned and individually tested; Babel parser creates ASTs for supported JS/JSX/TS/TSX; source is never executed; secret findings are redacted; heuristic rules do not claim exploitability; parse issues and limits produce correct partial states.

5. **AI-assisted analysis and source validation**
   - Acceptance: named provider/prompt/schema versions are recorded; AI candidates retain origin and verification separately; invalid evidence is rejected or retained as rejected with reasons; provider failure yields partial if deterministic findings remain usable.

6. **Patch proposals and historical risk**
   - Acceptance: each proposal is bound to head SHA and file hash and rechecked before return; stale proposals are blocked; history shows coverage and denominators; confirmed and possible recurrence are distinct; no predictive claims are made; no GitHub writes exist.

7. **Evaluation and readiness**
   - Acceptance: versioned dataset baselines and metric results are recorded before thresholds are chosen; maximum parser-input performance test passes the 60-second budget or justifies worker isolation; security, retention, deletion, deployment, runbooks, and documentation are reviewed.

## Documentation plan

Maintain:

- Architecture/data flow and module boundaries.
- OpenAPI contract and error/status glossary.
- GitHub permission matrix, OAuth state/PKCE flow, token lifecycle, and webhook handling.
- Lifecycle, finding provenance, context reason codes, and fingerprint-version rules.
- Data dictionary, indexes, 90-day/30-day retention, deletion and reconnect behavior.
- Threat model covering SSRF, resource exhaustion, credentials, webhooks, dependencies, and prompt injection.
- Config reference for limits and named providers.
- Deterministic rule catalog and limitations.
- Evaluation dataset guide, metric definitions, and baseline report.
- Maximum-input performance report and worker-thread decision record.
- Operational runbooks for token refresh/revocation, reauthorization, installation removal/suspension, stale reviews, and deletion.

## Remaining implementation decisions and limits

- Node.js is currently declared as `>=24`; pinning a supported major range for deployment remains an operational decision.
- Evaluation v1 is a small baseline fixture set, not a statistically reliable product-quality claim; improve and label it with controlled repositories before setting thresholds.
- The maximum-input performance test measures parser/analyzer elapsed time on the machine that runs Jest. Record the environment with the result; worker threads remain deferred unless representative measurements show a need.
- Fingerprint canonicalization is versioned as `insight-fingerprint-v1`; changes require a new version and explicit history comparison behavior.
- Reconnecting after uninstall grace requires explicit `retainHistory: true`; deleted snippets and patch contents cannot be restored.
- External GitHub App settings, MongoDB, and named LLM credentials are not present in this workspace, so end-to-end production integration remains configuration-dependent.
