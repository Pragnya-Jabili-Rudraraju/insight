const API_BASE_URL = (import.meta.env?.VITE_API_BASE_URL || 'http://localhost:4000/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor({ status, code, message, requestId, retryable }) {
    super(message || 'The request could not be completed.');
    this.name = 'ApiError';
    this.status = status;
    this.code = code || 'REQUEST_FAILED';
    this.requestId = requestId || null;
    this.retryable = Boolean(retryable);
  }
}

export function createApiClient(baseUrl = API_BASE_URL, fetcher = fetch) {
  let csrfToken = null;

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body != null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    let response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        ...options,
        headers,
        credentials: 'include',
      });
    } catch {
      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: 'Insight could not reach the backend. Check that it is running and try again.',
        retryable: true,
      });
    }

    if (response.status === 204) return null;

    let payload;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) {
        throw new ApiError({
          status: response.status,
          code: 'INVALID_BACKEND_RESPONSE',
          message: `The backend returned an unreadable response (${response.status}).`,
          retryable: response.status >= 500,
        });
      }
      return null;
    }

    if (!response.ok) {
      const detail = payload?.error || {};
      if (response.status === 401) csrfToken = null;
      throw new ApiError({
        status: response.status,
        code: detail.code,
        message: detail.message || `The backend returned ${response.status}.`,
        requestId: detail.requestId,
        retryable: detail.retryable,
      });
    }

    return payload;
  }

  async function getCsrfToken() {
    if (!csrfToken) {
      const response = await request('/csrf');
      if (!response?.csrfToken) {
        throw new ApiError({ code: 'CSRF_TOKEN_MISSING', message: 'Insight could not prepare a secure request. Refresh and try again.' });
      }
      csrfToken = response.csrfToken;
    }
    return csrfToken;
  }

  async function mutate(method, path, body) {
    async function send() {
      const token = await getCsrfToken();
      const headers = new Headers({ 'X-CSRF-Token': token });
      return request(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    try {
      return await send();
    } catch (error) {
      if (error.status !== 403 || error.code !== 'CSRF_INVALID') throw error;
      clearCsrfToken();
      return send();
    }
  }

  function clearCsrfToken() {
    csrfToken = null;
  }

  return {
    getSession: () => request('/session'),
    githubSignInUrl: () => `${baseUrl}/auth/github/start`,
    listRepositories: (cursor) => request(`/repositories${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
    selectRepository: (repositoryId, installationId, retainHistory = false) => mutate('PUT', `/repositories/${encodeURIComponent(repositoryId)}/selection`, {
      installationId: Number(installationId), selected: true, retainHistory,
    }),
    listPullRequests: (repositoryId, cursor = '1') => request(`/repositories/${encodeURIComponent(repositoryId)}/pull-requests?state=open&cursor=${encodeURIComponent(cursor)}`),
    getPullRequest: (repositoryId, pullRequestNumber) => request(`/repositories/${encodeURIComponent(repositoryId)}/pull-requests/${encodeURIComponent(pullRequestNumber)}`),
    createReview: (repositoryId, pullRequestNumber) => mutate('POST', '/reviews', { repositoryId, pullRequestNumber }),
    getReview: (executionId) => request(`/reviews/${encodeURIComponent(executionId)}`),
    listFindings: (executionId, cursor) => request(`/reviews/${encodeURIComponent(executionId)}/findings?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    getHistory: (repositoryId, cursor) => request(`/repositories/${encodeURIComponent(repositoryId)}/history?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    getConcept: (executionId, findingId) => request(`/reviews/${encodeURIComponent(executionId)}/findings/${encodeURIComponent(findingId)}/concept`),
    createPatchProposal: (executionId, findingId, expectedHeadSha, expectedFileHash) => mutate('POST', `/reviews/${encodeURIComponent(executionId)}/findings/${encodeURIComponent(findingId)}/patch-proposals`, { expectedHeadSha, expectedFileHash }),
    getPatchProposal: (proposalId) => request(`/patch-proposals/${encodeURIComponent(proposalId)}`),
    logout: async () => {
      try { return await mutate('POST', '/session/logout'); }
      finally { clearCsrfToken(); }
    },
    disconnectGitHub: async () => {
      try { return await mutate('POST', '/auth/github/disconnect'); }
      finally { clearCsrfToken(); }
    },
    clearCsrfToken,
  };
}

export const api = createApiClient();
