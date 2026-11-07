const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config/env");

const config = loadConfig({ NODE_ENV: "test" });
const app = createApp(config, {
  sessionMiddleware: session({ secret: "api-contract-test-session-secret", resave: false, saveUninitialized: false })
});

describe("documented V1 route surface", () => {
  test.each([
    ["get", "/api/v1/health", 200],
    ["get", "/api/v1/health/ready", 503],
    ["get", "/api/v1/auth/github/start", 503],
    ["get", "/api/v1/auth/github/callback?state=missing", 400],
    ["get", "/api/v1/session", 200],
    ["get", "/api/v1/csrf", 200],
    ["post", "/api/v1/auth/github/disconnect", 401],
    ["post", "/api/v1/session/logout", 403],
    ["get", "/api/v1/repositories", 401],
    ["get", "/api/v1/repositories/123/pull-requests", 401],
    ["get", "/api/v1/repositories/123/pull-requests/12", 401],
    ["put", "/api/v1/repositories/123/selection", 401],
    ["post", "/api/v1/reviews", 401],
    ["get", "/api/v1/reviews/507f1f77bcf86cd799439011", 401],
    ["get", "/api/v1/reviews/507f1f77bcf86cd799439011/findings", 401],
    ["get", "/api/v1/reviews/507f1f77bcf86cd799439011/findings/507f1f77bcf86cd799439012/concept", 401],
    ["get", "/api/v1/repositories/123/history", 401],
    ["delete", "/api/v1/repositories/123/history", 401],
    ["post", "/api/v1/reviews/507f1f77bcf86cd799439011/findings/507f1f77bcf86cd799439012/patch-proposals", 401],
    ["get", "/api/v1/patch-proposals/507f1f77bcf86cd799439011", 401],
    ["post", "/api/v1/webhooks/github", 503]
  ])("mounts %s %s and returns its expected precondition status", async (method, path, status) => {
    const response = await request(app)[method](path);
    expect(response.status).toBe(status);
    expect(response.status).not.toBe(404);
  });
});
