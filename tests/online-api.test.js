const assert = require("node:assert/strict");
const test = require("node:test");

process.env.HOSTED_MODE = "1";
const { startServer } = require("../server");

test("hosted API accepts Pages and rejects unrelated origins", async t => {
  const { server, url } = await startServer({ host: "127.0.0.1", port: 0, log: false });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const health = await fetch(`${url}/api/health`, {
    headers: { origin: "https://hanroots.github.io" }
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), "https://hanroots.github.io");
  assert.deepEqual(await health.json(), { service: "word-practice-generator", mode: "hosted" });

  const preflight = await fetch(`${url}/api/generate`, {
    method: "OPTIONS",
    headers: {
      origin: "https://hanroots.github.io",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "content-type");

  const unrelated = await fetch(`${url}/api/health`, {
    headers: { origin: "https://example.com" }
  });
  assert.equal(unrelated.status, 403);

  const empty = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { origin: "https://hanroots.github.io", "content-type": "application/json" },
    body: JSON.stringify({ wrongChars: [] })
  });
  assert.equal(empty.status, 400);

  const privateModel = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { origin: "https://hanroots.github.io", "content-type": "application/json" },
    body: JSON.stringify({
      wrongChars: ["拔"],
      apiConfig: { baseUrl: "http://127.0.0.1:1234", model: "test", apiKey: "dummy" }
    })
  });
  assert.equal(privateModel.status, 400);

  const staticFile = await fetch(`${url}/index.html`);
  assert.equal(staticFile.status, 404);
});
