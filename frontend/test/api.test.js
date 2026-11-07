import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createApiClient } from '../src/services/api.js';

test('sends browser credentials on API requests and preserves repository pagination metadata', async () => {
  const calls = [];
  const client = createApiClient('http://localhost:4000/api/v1', async (url, options) => {
    calls.push({ url, options });
    return Response.json({
      repositories: [{ id: '42', fullName: 'octo/app', selected: true }],
      nextCursor: 'opaque-page-token', hasMore: true, incomplete: true,
      incompleteReasons: ['installation_page_limit'], limit: 100,
    });
  });

  const result = await client.listRepositories();
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(result.nextCursor, 'opaque-page-token');
  assert.equal(result.hasMore, true);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.incompleteReasons, ['installation_page_limit']);
});

test('fetches and sends a session-bound CSRF token for mutations', async () => {
  const calls = [];
  const client = createApiClient('http://localhost:4000/api/v1', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/csrf')) return Response.json({ csrfToken: 'csrf-value' });
    return Response.json({ id: '42', selected: true });
  });

  await client.selectRepository('42', '99');
  assert.equal(calls[0].url, 'http://localhost:4000/api/v1/csrf');
  assert.equal(calls[1].options.method, 'PUT');
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers.get('X-CSRF-Token'), 'csrf-value');
  assert.deepEqual(JSON.parse(calls[1].options.body), { installationId: 99, selected: true, retainHistory: false });
});

test('refreshes a rejected CSRF token once before retrying a mutation', async () => {
  const calls = [];
  const client = createApiClient('http://localhost:4000/api/v1', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/csrf')) return Response.json({ csrfToken: `csrf-${calls.filter((call) => call.url.endsWith('/csrf')).length}` });
    if (options.headers.get('X-CSRF-Token') === 'csrf-1') {
      return Response.json({ error: { code: 'CSRF_INVALID', message: 'Refresh the page.' } }, { status: 403 });
    }
    return Response.json({ selected: true });
  });

  await client.selectRepository('42', '99');
  const mutationCalls = calls.filter((call) => call.options.method === 'PUT');
  assert.equal(mutationCalls.length, 2);
  assert.equal(mutationCalls[0].options.headers.get('X-CSRF-Token'), 'csrf-1');
  assert.equal(mutationCalls[1].options.headers.get('X-CSRF-Token'), 'csrf-2');
});

test('maps backend error envelopes to a typed API error', async () => {
  const client = createApiClient('http://localhost:4000/api/v1', async () => Response.json({
    error: { code: 'STALE_REVISION', message: 'The pull request changed.', requestId: 'req-1', retryable: false },
  }, { status: 409 }));

  await assert.rejects(client.getReview('execution-1'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'STALE_REVISION');
    assert.equal(error.requestId, 'req-1');
    return true;
  });
});

test('uses the numeric PR cursor and requests only the backend-supported findings page size', async () => {
  const urls = [];
  const client = createApiClient('http://localhost:4000/api/v1', async (url) => {
    urls.push(url);
    return Response.json({ pullRequests: [], nextCursor: null, hasMore: false, incomplete: false });
  });

  await client.listPullRequests('42', '10');
  await client.listFindings('execution-1', '507f1f77bcf86cd799439011');
  assert.match(urls[0], /pull-requests\?state=open&cursor=10$/);
  assert.match(urls[1], /findings\?limit=100&cursor=507f1f77bcf86cd799439011$/);
});

test('preserves PR truncation and history coverage from the backend contract', async () => {
  const responses = [
    { pullRequests: [{ number: 7 }], nextCursor: null, hasMore: true, incomplete: true, incompleteReason: 'github_page_limit' },
    {
      executions: [{ _id: 'execution-1', status: 'partial' }], nextCursor: null, hasMore: false,
      coverage: { reviewedPullRequests: 1, reviewedExecutionsAvailable: 1, aggregationIncomplete: true, aggregationRecordLimit: 500 },
      recurrence: [{ fingerprint: 'fingerprint-1', matchKind: 'confirmed', count: 2, comparableExecutionCount: 2 }],
      recurrenceCoverage: { occurrencesAvailable: 2, occurrencesAnalyzed: 2, fingerprintsReturned: 1, complete: true },
    },
  ];
  const client = createApiClient('http://localhost:4000/api/v1', async () => Response.json(responses.shift()));

  const pullRequests = await client.listPullRequests('42', '10');
  assert.equal(pullRequests.incomplete, true);
  assert.equal(pullRequests.incompleteReason, 'github_page_limit');
  const history = await client.getHistory('42');
  assert.equal(history.coverage.aggregationIncomplete, true);
  assert.equal(history.coverage.reviewedExecutionsAvailable, 1);
  assert.equal(history.recurrence[0].matchKind, 'confirmed');
  assert.equal(history.recurrenceCoverage.complete, true);
});

test('sends review and revision-pinned patch requests only to read-only proposal routes', async () => {
  const calls = [];
  const client = createApiClient('http://localhost:4000/api/v1', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/csrf')) return Response.json({ csrfToken: 'csrf-value' });
    if (options.method === 'POST' && url.endsWith('/reviews')) return Response.json({ execution: { _id: 'execution-1', status: 'partial' }, findings: [] });
    return Response.json({ patchProposal: { _id: 'patch-1', expectedHeadSha: 'a'.repeat(40), expectedFileHash: 'b'.repeat(64) } }, { status: 201 });
  });

  const review = await client.createReview('42', 7);
  const patch = await client.createPatchProposal('execution-1', 'finding-1', 'a'.repeat(40), 'b'.repeat(64));
  assert.equal(review.execution.status, 'partial');
  assert.equal(patch.patchProposal.expectedHeadSha, 'a'.repeat(40));
  assert.deepEqual(JSON.parse(calls.find((call) => call.url.endsWith('/reviews')).options.body), { repositoryId: '42', pullRequestNumber: 7 });
  const patchCall = calls.find((call) => call.url.includes('/patch-proposals'));
  assert.equal(patchCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(patchCall.options.body), { expectedHeadSha: 'a'.repeat(40), expectedFileHash: 'b'.repeat(64) });
  assert.equal(calls.some((call) => /\/(contents|git\/refs|merges)(\/|$)/.test(call.url)), false);
});
