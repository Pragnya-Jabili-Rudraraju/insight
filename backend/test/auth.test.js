const request = require("supertest");
const session = require("express-session");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config/env");
const { decryptToken, encryptToken } = require("../src/security/token-vault");

const key = "a".repeat(64);
const config = loadConfig({
  NODE_ENV: "test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough",
  TOKEN_ENCRYPTION_KEY: key,
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  GITHUB_ALLOWED_USER_ID: "12345"
});
const app = createApp(config, {
  sessionMiddleware: session({ secret: config.SESSION_SECRET, resave: false, saveUninitialized: false })
});

describe("GitHub login boundary and session protections", () => {
  test("starts GitHub authorization with state, PKCE S256, and signup disabled", async () => {
    const browser = request.agent(app);
    const response = await browser.get("/api/v1/auth/github/start");
    expect(response.status).toBe(302);
    const target = new URL(response.headers.location);
    expect(target.hostname).toBe("github.com");
    expect(target.searchParams.get("state")).toHaveLength(43);
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    expect(target.searchParams.get("allow_signup")).toBe("false");

    const rejected = await browser.get("/api/v1/auth/github/callback?code=fake&state=wrong");
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("OAUTH_STATE_INVALID");
  });

  test("requires the session-bound CSRF token for logout", async () => {
    const browser = request.agent(app);
    const tokenResponse = await browser.get("/api/v1/csrf");
    const csrfToken = tokenResponse.body.csrfToken;
    expect(csrfToken).toHaveLength(43);

    const blocked = await browser.post("/api/v1/session/logout");
    expect(blocked.status).toBe(403);
    const allowed = await browser.post("/api/v1/session/logout").set("X-CSRF-Token", csrfToken);
    expect(allowed.status).toBe(204);
  });

  test("does not grant CORS access to arbitrary origins", async () => {
    const response = await request(app).options("/api/v1/session").set("Origin", "https://attacker.example");
    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("credential encryption", () => {
  test("encrypts tokens with authenticated encryption and rejects tampering", () => {
    const token = "private-refresh-token";
    const encrypted = encryptToken(token, key);
    expect(encrypted).not.toContain(token);
    expect(decryptToken(encrypted, key)).toBe(token);
    const parts = encrypted.split(".");
    parts[3] = `${parts[3][0] === "a" ? "b" : "a"}${parts[3].slice(1)}`;
    expect(() => decryptToken(parts.join("."), key)).toThrow();
  });
});
