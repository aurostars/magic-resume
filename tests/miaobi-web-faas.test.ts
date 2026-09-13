import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebFaasHandler } from "../miaobi/web-entry";
import { buildWebFaas } from "../scripts/miaobi/build-web-faas";

const HTML = `<!doctype html><html><head><link rel="stylesheet" href="https://tos.example.test/magic-resume/releases/release/app.css"></head><body><a href="https://api.example.test/faas">fallback</a><script>window.__MAGIC_RESUME_RUNTIME__={"apiFunctionUrl":"https://api.example.test/faas","assetBaseUrl":"https://tos.example.test/magic-resume/releases/release/"}</script><script type="module" src="https://tos.example.test/magic-resume/releases/release/app.js"></script></body></html>`;

function request(method = "GET") {
  return new Request("https://magic.example.test/", { method });
}

test("GET serves the finalized HTML with no-store security headers and a narrow CSP", async () => {
  const response = await createWebFaasHandler(HTML)(request());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Magic-Resume-Faas"), "magic-resume-web");
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'unsafe-inline' https:\/\/tos\.example\.test\/magic-resume\/releases\/release\//);
  assert.match(csp, /connect-src https:(?:;|$)/);
  assert.doesNotMatch(csp, /connect-src[^;]*api\.example\.test/);
  assert.doesNotMatch(csp, /workers\.dev|\*/);
});

test("HEAD returns the same headers without an HTML body", async () => {
  const handler = createWebFaasHandler(HTML);
  const get = await handler(request());
  const head = await handler(request("HEAD"));

  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.deepEqual([...head.headers], [...get.headers]);
});

for (const method of ["POST", "PUT", "DELETE"]) {
  test(`${method} is rejected without reflecting the HTML`, async () => {
    const response = await createWebFaasHandler(HTML)(request(method));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
    assert.equal(await response.text(), "");
  });
}

test("the bundled handler embeds safely serialized finalized HTML before request time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-web-faas-"));
  const hostileHtml = HTML.replace("</body>", "<p>` \${danger} </script> \\ end</p></body>");
  try {
    const bundlePath = await buildWebFaas(hostileHtml, directory);
    const bundle = await readFile(bundlePath, "utf8");
    assert.equal(bundle.includes("workers.dev"), false);
    assert.equal(bundle.includes("sk-test-miaobi-secret"), false);

    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve(bundlePath)];
    const handler = require(bundlePath) as (request: Request) => Promise<Response>;
    const response = await handler(request());
    const body = await response.text();
    assert.equal(body, hostileHtml);
    assert.ok(body.indexOf("window.__MAGIC_RESUME_RUNTIME__") < body.indexOf('type="module"'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
