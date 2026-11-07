const { githubApiRequest, revokeGrant } = require("../src/auth/github-client");

describe("fixed-host GitHub HTTP adapter", () => {
  afterEach(() => jest.restoreAllMocks());

  test("rejects untrusted paths before making a request", async () => {
    const fetcher = jest.spyOn(global, "fetch");
    await expect(githubApiRequest("//attacker.example/path", "token")).rejects.toThrow("Invalid internal GitHub API path");
    await expect(githubApiRequest("/repos/owner/../other", "token")).rejects.toThrow("Invalid internal GitHub API path");
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("disables redirects on GitHub reads and credential revocation", async () => {
    const fetcher = jest.spyOn(global, "fetch").mockImplementation(async (_url, options) => {
      if (options.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    await githubApiRequest("/user", "test-access-token");
    await revokeGrant({ GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret" }, "test-access-token");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, options]) => options.redirect === "error")).toBe(true);
  });
});
