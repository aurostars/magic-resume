import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWebFaasHandler } from "../miaobi/web-entry";
import { injectMiaobiRuntime } from "../miaobi/runtime-config";
import { buildWebFaas } from "../scripts/miaobi/build-web-faas";

const PAGES_ORIGIN = "https://aurostars.github.io";
const ASSET_BASE = `${PAGES_ORIGIN}/magic-resume/objects/${"1".repeat(64)}/`;
const API_URL = "https://magic.solutionsuite.cn/api/faas/api-id";
const SHELL = `<!doctype html><html><head><link rel="stylesheet" href="${ASSET_BASE}assets/app.css"></head><body><img src="${ASSET_BASE}assets/logo.png"><script type="module" src="${ASSET_BASE}assets/app.js"></script></body></html>`;
const HTML = injectMiaobiRuntime(SHELL, {
  platform: "miaobi",
  apiFunctionUrl: API_URL,
  assetBaseUrl: ASSET_BASE,
});

function request(method = "GET") {
  return new Request("https://magic.example.test/", { method });
}

test("runtime config is injected before modules only for canonical Pages asset URLs", () => {
  assert.ok(HTML.indexOf("window.__MAGIC_RESUME_RUNTIME__") < HTML.indexOf('type="module"'));
  assert.match(HTML, new RegExp(`${PAGES_ORIGIN}/magic-resume/objects/`));

  for (const assetBaseUrl of [
    "https://tos.example.test/magic-resume/releases/release/",
    "https://tenant.workers.dev/magic-resume/",
    "https://aurostars.github.io.evil.example/magic-resume/",
  ]) {
    assert.throws(() => injectMiaobiRuntime(SHELL, {
      platform: "miaobi",
      apiFunctionUrl: API_URL,
      assetBaseUrl,
    }), /MIAOBI_INVALID_PAGES_URL/);
  }
});

test("GET serves finalized Pages HTML with no-store headers and CSP for assets, API and HTTPS WebDAV", async () => {
  const response = await createWebFaasHandler(HTML)(request());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), HTML);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("X-Magic-Resume-Faas"), "magic-resume-web");
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  for (const directive of ["script-src", "style-src", "font-src", "img-src", "media-src"]) {
    assert.match(csp, new RegExp(`${directive}[^;]*https:\\/\\/aurostars\\.github\\.io(?:\\s|;|$)`));
  }
  assert.match(csp, /connect-src[^;]*https:\/\/magic\.solutionsuite\.cn(?:\/|\s|;)/);
  assert.match(csp, /connect-src[^;]*https:(?:\s|;|$)/);
  assert.doesNotMatch(csp, /tos|cloudflare|workers\.dev|\*/i);
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

test("the real bundle serves Pages object URLs with runtime config before modules", async () => {
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
    assert.match(body, /https:\/\/aurostars\.github\.io\/magic-resume\/objects\/[0-9a-f]{64}\/assets\/app\.js/);
    assert.match(body, /https:\/\/aurostars\.github\.io\/magic-resume\/objects\/[0-9a-f]{64}\/assets\/app\.css/);
    assert.match(response.headers.get("Content-Security-Policy") ?? "", /https:\/\/aurostars\.github\.io/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("non-Pages runtime HTML is rejected before a bundle artifact is published", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-web-faas-invalid-"));
  const invalid = HTML.replaceAll(PAGES_ORIGIN, "https://legacy.workers.dev");
  const bundlePath = join(directory, "web-faas.cjs");
  try {
    await assert.rejects(buildWebFaas(invalid, directory), /MIAOBI_INVALID_PAGES_URL/);
    await assert.rejects(access(bundlePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


const INVALID_API_URLS = [
  "https://tos.example.test/api/faas/api-id",
  "https://tenant.workers.dev/api/faas/api-id",
  "https://cloudflare.example/api/faas/api-id",
  "https://" + "user@" + "magic.solutionsuite.cn/api/faas/api-id",
  "https://magic.solutionsuite.cn:444/api/faas/api-id",
  "https://magic.solutionsuite.cn/api/faas/",
  "https://magic.solutionsuite.cn/api/faas/api-id?query=1",
  "https://magic.solutionsuite.cn/api/faas/api-id#fragment",
  "https://magic.solutionsuite.cn/other/api-id",
];

for (const invalidApiUrl of INVALID_API_URLS) {
  test(`runtime injection rejects noncanonical API URL: ${invalidApiUrl}`, () => {
    assert.throws(() => injectMiaobiRuntime(SHELL, {
      platform: "miaobi",
      apiFunctionUrl: invalidApiUrl,
      assetBaseUrl: ASSET_BASE,
    }), /MIAOBI_INVALID_RUNTIME_CONFIG/);
  });

  test(`direct handler rejects noncanonical API URL: ${invalidApiUrl}`, () => {
    assert.throws(
      () => createWebFaasHandler(HTML.replace(API_URL, invalidApiUrl)),
      /MIAOBI_INVALID_(?:RUNTIME_CONFIG|WEB_HTML)/,
    );
  });
}

test("bundle build rejects a noncanonical API URL before publishing an artifact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-web-faas-invalid-api-"));
  const bundlePath = join(directory, "web-faas.cjs");
  try {
    await assert.rejects(
      buildWebFaas(HTML.replace(API_URL, "https://tenant.workers.dev/api/faas/api-id"), directory),
      /MIAOBI_INVALID_RUNTIME_CONFIG/,
    );
    await assert.rejects(access(bundlePath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
