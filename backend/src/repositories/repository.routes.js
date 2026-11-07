const express = require("express");
const { z } = require("zod");
const SelectedRepository = require("../models/selected-repository.model");
const { createRequireGitHubAccess } = require("../auth/auth-middleware");
const { createRequireSelectedRepository } = require("../auth/repository-access");
const { githubApiRequest } = require("../auth/github-client");
const { retainSanitizedHistory } = require("../retention/retention.service");
const { requireCsrf } = require("../security/csrf");
const { invalidateCurrentCredential } = require("../auth/token-service");

const installationListSchema = z.object({ installations: z.array(z.object({ id: z.number().int().positive() }).passthrough()) });
const repositoryListSchema = z.object({ repositories: z.array(z.object({
  id: z.number().int().positive(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string() }).passthrough()
}).passthrough()) });
const pullListSchema = z.array(z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  base: z.object({ sha: z.string() }).passthrough(),
  head: z.object({ sha: z.string() }).passthrough(),
  user: z.object({ login: z.string() }).passthrough()
}).passthrough());

async function upstreamError(error, req, res, next) {
  if (error.status === 401) {
    await invalidateCurrentCredential().catch(() => {});
    return res.status(401).json({ error: { code: "GITHUB_REAUTH_REQUIRED", message: "Reconnect GitHub to continue.", retryable: false, requestId: req.requestId } });
  }
  if (error.status === 403) return res.status(403).json({ error: { code: "GITHUB_ACCESS_DENIED", message: "The GitHub account or App does not have access to this resource.", retryable: false, requestId: req.requestId } });
  if (error.status === 404) return res.status(404).json({ error: { code: "GITHUB_RESOURCE_UNAVAILABLE", message: "The GitHub resource was not found or is no longer accessible.", retryable: false, requestId: req.requestId } });
  if (error.status === 502) return res.status(502).json({ error: { code: error.code, message: "GitHub could not complete the request. Try again shortly.", retryable: true, requestId: req.requestId } });
  return next(error);
}

function encodeRepositoryCursor(state) {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeRepositoryCursor(value) {
  if (value == null || value === "") return { installationId: null, page: 1 };
  if (typeof value !== "string" || value.length > 80 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const state = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!(state.installationId === null || (typeof state.installationId === "string" && /^\d+$/.test(state.installationId))) || !Number.isInteger(state.page) || state.page < 1 || state.page > 10) return null;
    return state;
  } catch { return null; }
}

function createRepositoryRouter(config, dependencies = {}) {
  const router = express.Router();
  const requireGitHub = createRequireGitHubAccess(config);
  const requireSelected = createRequireSelectedRepository();
  const githubRequest = dependencies.githubApiRequest || githubApiRequest;

  router.get("/repositories", requireGitHub, async (req, res, next) => {
    try {
      const installations = [];
      let installationPage = 1;
      let installationLimitReached = false;
      while (installationPage <= 10) {
        const result = installationListSchema.parse(await githubRequest(`/user/installations?per_page=100&page=${installationPage}`, req.githubAccessToken));
        installations.push(...result.installations);
        if (result.installations.length < 100) break;
        if (installationPage === 10) installationLimitReached = true;
        installationPage += 1;
      }
      const cursorState = decodeRepositoryCursor(req.query.cursor);
      if (!cursorState) {
        return res.status(400).json({ error: { code: "INVALID_REPOSITORY_CURSOR", message: "Repository page cursor is invalid. Restart the repository list.", retryable: false, requestId: req.requestId } });
      }
      const cursorIndex = cursorState.installationId == null
        ? 0
        : installations.findIndex((installation) => String(installation.id) === cursorState.installationId);
      if (cursorIndex < 0) return res.status(409).json({ error: { code: "REPOSITORY_CURSOR_STALE", message: "The available installations changed. Restart the repository list.", retryable: false, requestId: req.requestId } });
      const repositories = [];
      const pageSize = config.MAX_REPOSITORY_RESULTS;
      let nextState = null;
      let installationIndex = cursorIndex;
      let page = cursorState.page;
      let repositoryPageLimitReached = false;
      if (installationIndex < installations.length) {
        const installation = installations[installationIndex];
        const result = repositoryListSchema.parse(await githubRequest(
          `/user/installations/${installation.id}/repositories?per_page=${pageSize}&page=${page}`,
          req.githubAccessToken
        ));
        repositories.push(...result.repositories.map((repo) => ({ ...repo, installationId: installation.id })));
        if (result.repositories.length === pageSize) {
          if (page < 10) nextState = { installationId: String(installation.id), page: page + 1 };
          else if (installationIndex + 1 < installations.length) nextState = { installationId: String(installations[installationIndex + 1].id), page: 1 };
          else repositoryPageLimitReached = true;
        } else if (installationIndex + 1 < installations.length) {
          nextState = { installationId: String(installations[installationIndex + 1].id), page: 1 };
        } else if (installationLimitReached) {
          repositoryPageLimitReached = false;
        } else {
          nextState = null;
        }
      }
      const selected = await SelectedRepository.find({ accessStatus: { $in: ["active", "reauthorization_required"] } }).lean();
      const byId = new Map(selected.map((repo) => [repo.githubRepositoryId, repo]));
      const items = repositories.slice(0, pageSize).map((repo) => ({
        id: String(repo.id), fullName: repo.full_name, name: repo.name, owner: repo.owner.login,
        isPrivate: repo.private, installationId: String(repo.installationId),
        selected: byId.has(String(repo.id)), accessStatus: byId.get(String(repo.id))?.accessStatus || "available"
      }));
      const incompleteReasons = [];
      if (installationLimitReached) incompleteReasons.push("installation_page_limit");
      if (repositoryPageLimitReached) incompleteReasons.push("repository_page_limit");
      const nextCursor = nextState ? encodeRepositoryCursor(nextState) : null;
      return res.json({ repositories: items, nextCursor, hasMore: Boolean(nextCursor), incomplete: incompleteReasons.length > 0, incompleteReasons, limit: pageSize });
    } catch (error) {
      if (error.status) return upstreamError(error, req, res, next);
      return next(error);
    }
  });

  router.put("/repositories/:repositoryId/selection", requireGitHub, requireCsrf, async (req, res, next) => {
    const body = z.object({ installationId: z.coerce.number().int().positive(), selected: z.boolean(), retainHistory: z.boolean().optional().default(false) }).safeParse(req.body);
    if (!body.success || !/^\d+$/.test(req.params.repositoryId)) {
      return res.status(400).json({ error: { code: "INVALID_SELECTION", message: "Repository selection is invalid.", retryable: false, requestId: req.requestId } });
    }
    const { installationId, selected: shouldSelect, retainHistory } = body.data;
    try {
      let matchedRepository = null;
      for (let page = 1; page <= 10; page += 1) {
        const result = repositoryListSchema.parse(await githubRequest(
          `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          req.githubAccessToken
        ));
        matchedRepository = result.repositories.find((repo) => String(repo.id) === req.params.repositoryId) || matchedRepository;
        if (matchedRepository || result.repositories.length < 100) break;
      }
      if (!matchedRepository) return res.status(404).json({ error: { code: "REPOSITORY_NOT_INSTALLED", message: "The repository is not available to this GitHub App installation.", retryable: false, requestId: req.requestId } });

      if (!shouldSelect) {
        await SelectedRepository.updateOne({ githubRepositoryId: req.params.repositoryId }, { $set: { accessStatus: "unselected", revokedAt: new Date() } });
        return res.json({ id: req.params.repositoryId, selected: false });
      }
      const saved = await SelectedRepository.findOneAndUpdate({ githubRepositoryId: req.params.repositoryId }, {
        $set: {
          installationId: String(installationId), fullName: matchedRepository.full_name,
          isPrivate: matchedRepository.private, accessStatus: "active", revokedAt: null, selectedAt: new Date()
        }
      }, { upsert: true, new: true, runValidators: true });
      if (retainHistory) await retainSanitizedHistory(req.params.repositoryId);
      return res.json({ id: saved.githubRepositoryId, fullName: saved.fullName, selected: true });
    } catch (error) {
      if (error.status) return upstreamError(error, req, res, next);
      return next(error);
    }
  });

  router.get("/repositories/:repositoryId/pull-requests", requireGitHub, requireSelected, async (req, res, next) => {
    const state = z.enum(["open", "closed", "all"]).catch("open").parse(req.query.state);
    try {
      const parsedPage = z.coerce.number().int().min(1).max(10).safeParse(req.query.cursor ?? 1);
      if (!parsedPage.success) return res.status(400).json({ error: { code: "INVALID_PULL_REQUEST_CURSOR", message: "Pull request page cursor must be between 1 and 10.", retryable: false, requestId: req.requestId } });
      const page = parsedPage.data;
      const result = pullListSchema.parse(await githubRequest(
        `/repos/${req.selectedRepository.fullName.split("/").map(encodeURIComponent).join("/")}/pulls?state=${state}&per_page=50&page=${page}`,
        req.githubAccessToken
      ));
      const hasMore = result.length === 50;
      const incomplete = hasMore && page === 10;
      return res.json({ pullRequests: result.map((pull) => ({
        number: pull.number, title: pull.title, state: pull.state, url: pull.html_url,
        author: pull.user.login, createdAt: pull.created_at, updatedAt: pull.updated_at,
        baseSha: pull.base.sha, headSha: pull.head.sha
      })), nextCursor: hasMore && page < 10 ? String(page + 1) : null, hasMore, incomplete, limit: 50, incompleteReason: incomplete ? "github_page_limit" : null });
    } catch (error) {
      if (error.status) return upstreamError(error, req, res, next);
      return next(error);
    }
  });

  router.get("/repositories/:repositoryId/pull-requests/:number", requireGitHub, requireSelected, async (req, res, next) => {
    const number = z.coerce.number().int().positive().safeParse(req.params.number);
    if (!number.success) return res.status(400).json({ error: { code: "INVALID_PULL_REQUEST", message: "Pull request number is invalid.", retryable: false, requestId: req.requestId } });
    try {
      const pull = z.object({
        number: z.number().int().positive(), title: z.string(), state: z.string(), html_url: z.string().url(),
        base: z.object({ sha: z.string(), ref: z.string() }).passthrough(),
        head: z.object({ sha: z.string(), ref: z.string() }).passthrough()
      }).passthrough().parse(await githubRequest(
        `/repos/${req.selectedRepository.fullName.split("/").map(encodeURIComponent).join("/")}/pulls/${number.data}`,
        req.githubAccessToken
      ));
      return res.json({
        number: pull.number, title: pull.title, state: pull.state, url: pull.html_url,
        base: { sha: pull.base.sha, ref: pull.base.ref }, head: { sha: pull.head.sha, ref: pull.head.ref }
      });
    } catch (error) {
      if (error.status) return upstreamError(error, req, res, next);
      return next(error);
    }
  });

  return router;
}

module.exports = { createRepositoryRouter, decodeRepositoryCursor, encodeRepositoryCursor };
