const { z } = require("zod");
const { readJsonLimited } = require("../utils/http-json");

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive(),
  token_type: z.string().optional()
});
const userResponseSchema = z.object({ id: z.number().int().positive(), login: z.string().min(1) });

async function githubRequest(url, options = {}) {
  const { maxResponseBytes = 1024 * 1024, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, redirect: "error", signal: fetchOptions.signal || AbortSignal.timeout(10_000) });
  const body = await readJsonLimited(response, maxResponseBytes);
  if (!response.ok) {
    const error = new Error("GitHub authorization request failed.");
    error.code = response.status === 401 ? "GITHUB_REAUTH_REQUIRED" : "GITHUB_UPSTREAM_ERROR";
    error.status = response.status === 401 || response.status === 403 || response.status === 404 ? response.status : 502;
    throw error;
  }
  return body;
}

async function githubApiRequest(path, accessToken, options = {}) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("Invalid internal GitHub API path.");
  }
  const url = new URL(path, "https://api.github.com");
  if (url.hostname !== "api.github.com" || url.protocol !== "https:") throw new Error("GitHub API host is not allowed.");
  return githubRequest(url.toString(), {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Insight",
      ...(options.headers || {})
    }
  });
}

function tokenForm(config, fields) {
  const body = new URLSearchParams({ client_id: config.GITHUB_CLIENT_ID, client_secret: config.GITHUB_CLIENT_SECRET, ...fields });
  return { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body };
}

async function exchangeCode(config, code, codeVerifier) {
  const response = await githubRequest("https://github.com/login/oauth/access_token", tokenForm(config, {
    code,
    redirect_uri: config.GITHUB_CALLBACK_URL,
    code_verifier: codeVerifier
  }));
  const parsed = tokenResponseSchema.safeParse(response);
  if (!parsed.success) {
    const error = new Error("GitHub authorization could not be completed.");
    error.status = 401;
    error.code = "GITHUB_OAUTH_FAILED";
    throw error;
  }
  return parsed.data;
}

async function getAuthenticatedUser(accessToken) {
  const response = await githubRequest("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Insight"
    }
  });
  return userResponseSchema.parse(response);
}

async function refreshUserToken(config, refreshToken) {
  const response = await githubRequest("https://github.com/login/oauth/access_token", tokenForm(config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken
  }));
  const parsed = tokenResponseSchema.safeParse(response);
  if (!parsed.success) {
    const error = new Error("GitHub authorization has expired.");
    error.status = 401;
    error.code = "GITHUB_REAUTH_REQUIRED";
    throw error;
  }
  return parsed.data;
}

async function revokeGrant(config, accessToken) {
  const authorization = Buffer.from(`${config.GITHUB_CLIENT_ID}:${config.GITHUB_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`https://api.github.com/applications/${encodeURIComponent(config.GITHUB_CLIENT_ID)}/grant`, {
    method: "DELETE",
    redirect: "error",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Basic ${authorization}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: accessToken }),
    signal: AbortSignal.timeout(10_000)
  });
  return response.ok || response.status === 404;
}

module.exports = { exchangeCode, getAuthenticatedUser, githubApiRequest, refreshUserToken, revokeGrant };
