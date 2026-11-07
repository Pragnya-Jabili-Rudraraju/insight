# Insight REST API contract (V1 draft)

This contract is the frontend/backend boundary for V1. Routes are JSON REST under `/api/v1`; browser authentication uses a secure session cookie. GitHub and AI are not available in the frontend prototype until configured. All IDs are opaque strings unless noted. Dates are ISO 8601 UTC.

## Common behavior

- JSON request and response bodies use `application/json`; request bodies are currently limited to 32 KiB.
- Errors have `{ "error": { "code": "...", "message": "...", "retryable": false, "requestId": "..." } }`.
- Mutations require a valid session and `X-CSRF-Token` header returned by `GET /csrf`. `GET` routes do not mutate state.
- Every repository and review route rechecks the verified user, selected repository, active installation, and current GitHub authorization.
- Review status is one of `created`, `running`, `completed`, `partial`, `failed`, or `stale`. V1 creates and completes an execution synchronously, while the resource shape leaves room for later polling.
- Finding provenance is `deterministic` or `ai`; verification is `unverified`, `evidence_checked`, or `rule_checked`; disposition is `candidate`, `accepted`, or `rejected`.
- A source location includes `path`, `side` (`base` or `head`), and one-based `startLine`/`endLine`. Findings must reference the immutable review snapshot.

## Session and GitHub authorization

| Method | Path | Purpose |
|---|---|---|
| GET | `/auth/github/start` | Start GitHub App user authorization; sets state/PKCE transaction cookies and redirects to GitHub. |
| GET | `/auth/github/callback` | Validate state, exchange authorization code, verify the configured GitHub account, establish session. |
| GET | `/session` | Return `{ authenticated, githubUser?, githubConnection? }`; no credentials. |
| POST | `/auth/github/disconnect` | Revoke GitHub authorization and invalidate stored credentials. |
| POST | `/session/logout` | Revoke local session and clear cookies. |
| GET | `/csrf` | Return a CSRF token for the current session. |
| GET | `/health` and `/health/ready` | Liveness and MongoDB readiness status. |

## Repository and pull request selection

| Method | Path | Purpose |
|---|---|---|
| GET | `/repositories?cursor=` | List up to `MAX_REPOSITORY_RESULTS` repositories from the verified account's App installations, with selected and access status. `nextCursor` continues pagination. `incomplete` and `incompleteReasons` identify an installation or GitHub page cap that could not be continued. |
| GET | `/repositories/:repositoryId/pull-requests?state=open&cursor=1` | List up to 50 accessible PRs per page. `cursor` is the one-based numeric GitHub page; pages are capped at 10. Response includes `nextCursor`, `hasMore`, and `incomplete` when the page ceiling prevents further retrieval. |
| GET | `/repositories/:repositoryId/pull-requests/:number` | Return PR metadata and current base/head SHAs for selection. |
| PUT | `/repositories/:repositoryId/selection` | Select or deselect a repository within the verified GitHub App installation. Body: `{ installationId, selected, retainHistory? }`. `retainHistory` is an explicit reconnect choice. |

## Reviews and findings

`POST /reviews` request (requires `X-CSRF-Token`):

```json
{ "repositoryId": "github-repository-id", "pullRequestNumber": 12 }
```

| Method | Path | Purpose |
|---|---|---|
| POST | `/reviews` | Create a new execution; repeating creates a distinct execution. |
| GET | `/reviews/:executionId` | Return status, immutable snapshot, analyzer/prompt/provider versions, quality summary, coverage, limits, and timestamps. |
| GET | `/reviews/:executionId/findings?cursor=&limit=` | Return validated findings with provenance, verification, evidence, impact trail, test guidance, and recurrence state. The page limit is capped by `MAX_FINDINGS_PER_RESPONSE`; `hasMore` and `nextCursor` report additional findings. |
| GET | `/repositories/:repositoryId/history?cursor=&limit=` | Return descriptive review history and recurrence with denominators and coverage. Execution pages are capped by `MAX_HISTORY_EXECUTIONS_PER_RESPONSE`; each aggregation source reads at most `MAX_HISTORY_AGGREGATE_RECORDS` records and returns at most `MAX_HISTORY_AGGREGATE_ROWS` rows, with incomplete coverage disclosed. |
| DELETE | `/repositories/:repositoryId/history` | Delete stored review data for the selected repository. |

Finding and history limits are configurable in the backend environment. Findings responses are capped by `MAX_FINDINGS_PER_RESPONSE`. History response fields include exact available denominators, analyzed counts, `aggregationIncomplete`, and recurrence coverage so capped analysis is not presented as complete. Repository results paginate with an opaque cursor; PR pages use numeric GitHub page cursors. At GitHub's page ceiling, a full final page is marked `incomplete` rather than silently treated as the end.

Execution snapshot fields: `repositoryId`, `pullRequestNumber`, `baseSha`, `headSha`. Completion includes a final SHA check; a changed revision yields `stale`. AI provider failure yields `partial` only if deterministic results remain usable. Limit and skipped-work details are explicit.

Finding fields include `id`, `executionId`, `category`, `severity`, `title`, `explanation`, `location`, `evidence[]`, `suggestedImprovement`, `confidence`, `provenance`, `verification`, `disposition`, `impactTrail[]`, `testGuidance`, optional `testCode`, optional `concept`, and `recurrence`. Evidence includes the pinned path/side/line range, redacted snippet, and content hash reference. Confidence is explanatory metadata, not proof.

## Concepts and patch proposals

| Method | Path | Purpose |
|---|---|---|
| GET | `/reviews/:executionId/findings/:findingId/concept` | Return optional concept explanation relevant to a finding. |
| POST | `/reviews/:executionId/findings/:findingId/patch-proposals` | Create a single-finding proposal after checking expected head SHA and source-file hash. |
| GET | `/patch-proposals/:proposalId` | Return original/proposed code, unified diff artifact, validation state, and revision binding. |

Patch proposal creation request (requires `X-CSRF-Token`):

```json
{ "expectedHeadSha": "immutable-head-sha", "expectedFileHash": "sha256-of-source-file" }
```

Provider/model are server-configured from the named-provider allowlist; clients cannot select an arbitrary endpoint. Patch proposals are suggestions for copy/download only. There is no GitHub write endpoint.

## Webhook and status codes

`POST /webhooks/github` accepts signed installation events only; it is not a browser session route. It validates the raw-body HMAC signature and delivery ID before acting.

Expected status codes: `200` success, `201` created, `202` running, `400` invalid input, `401` unauthenticated/reauthorization required, `403` unauthorized or CSRF failure, `404` unavailable resource, `409` stale revision/state conflict, `413` configured limit exceeded, `422` semantically invalid request, `429` rate limited, `502` upstream provider/GitHub error, `503` temporarily unavailable, `500` unexpected server error. Error messages never include tokens, secrets, raw private source, or provider response bodies.

## Frontend integration notes

The existing prototype currently uses clearly labeled sample data and must continue to do so until the user deliberately connects the real API. The API provides separate state and data fields for loading, empty findings, permission/reauthorization, stale revisions, partial/limit notices, and errors. UI wording may be concise while retaining the machine-readable status and details in the response.
