const { createHmac } = require("node:crypto");
const request = require("supertest");
const { createApp } = require("../src/app");
const { loadConfig } = require("../src/config/env");
const { verifyWebhookSignature } = require("../src/webhooks/github-webhook");

const secret = "webhook-test-secret";
const payload = Buffer.from(JSON.stringify({ action: "deleted", installation: { id: 123 } }));

describe("signed GitHub webhook boundary", () => {
  test("accepts only matching HMAC-SHA256 signatures", () => {
    const signature = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, `${signature.slice(0, -1)}0`, secret)).toBe(false);
    expect(verifyWebhookSignature(payload, "sha1=bad", secret)).toBe(false);
  });

  test("rejects an invalid signature before parsing or storing an event", async () => {
    const config = loadConfig({ NODE_ENV: "test", GITHUB_APP_WEBHOOK_SECRET: secret });
    const app = createApp(config);
    const response = await request(app)
      .post("/api/v1/webhooks/github")
      .set("Content-Type", "application/json")
      .set("X-GitHub-Delivery", "delivery-1")
      .set("X-GitHub-Event", "installation")
      .set("X-Hub-Signature-256", "sha256=0".repeat(32))
      .send(payload);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
  });
});
