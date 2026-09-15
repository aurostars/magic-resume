import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { buildApiFaas } from "../scripts/miaobi/build-faas";

const require = createRequire(import.meta.url);

test("the API build emits a standalone CommonJS FaaS handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-faas-"));
  try {
    const gitCommit = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
    const nonce = "0123456789abcdef0123456789abcdef";
    const buildMarker = `${gitCommit}.${nonce}`;
    const bundlePath = await buildApiFaas(directory, { gitCommit, nonce });
    assert.equal(bundlePath, join(directory, "api-faas.cjs"));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "api-faas.meta.json"), "utf8")), {
      schemaVersion: 1,
      gitCommit,
      buildMarker,
      bundleSha256: (await import("node:crypto")).createHash("sha256")
        .update(await readFile(bundlePath))
        .digest("hex"),
    });

    const handler = require(bundlePath) as (request: Request) => Promise<Response>;
    assert.equal(typeof handler, "function");

    const notFound = await handler(
      new Request(
        "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fmissing",
        { method: "POST" },
      ),
    );
    assert.equal(notFound.status, 404);
    assert.equal(notFound.headers.get("X-Magic-Resume-Build"), buildMarker);
    assert.deepEqual(await notFound.json(), {
      error: "Not found",
      code: "notFound",
    });

    const methodNotAllowed = await handler(
      new Request(
        "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar",
      ),
    );
    assert.equal(methodNotAllowed.status, 405);
    assert.equal(methodNotAllowed.headers.get("Allow"), "POST");
    assert.deepEqual(await methodNotAllowed.json(), {
      error: "Method not allowed",
      code: "methodNotAllowed",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the API bundle loads and serves health without runtime require", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-faas-runtime-"));
  try {
    const bundlePath = await buildApiFaas(directory, {
      gitCommit: "59a06b5c2c127d287d01016e5be4d781e310fe2e",
      nonce: "0123456789abcdef0123456789abcdef",
    });
    const module = { exports: undefined as unknown };
    const upstreamCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      upstreamCalls.push(String(input));
      return new Response("<multistatus/>", {
        status: 207,
        headers: { "Content-Type": "application/xml" },
      });
    };
    runInNewContext(await readFile(bundlePath, "utf8"), {
      module,
      require: (specifier: string) => {
        throw new Error(`runtime require is unavailable: ${specifier}`);
      },
      AbortController,
      AbortSignal,
      DOMException,
      Headers,
      Request,
      Response,
      URL,
      TextDecoder,
      TextEncoder,
      btoa,
      clearTimeout,
      fetch: fetchImpl,
      setTimeout,
    });

    const handler = module.exports as (request: Request) => Promise<Response>;
    const response = await handler(new Request(
      "https://magic.solutionsuite.cn/api/faas/id?__path=%2F__miaobi_health__",
    ));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("X-Magic-Resume-Faas"), "magic-resume-api");
    assert.deepEqual(await response.json(), { error: "Not found", code: "notFound" });

    const proxied = await handler(new Request(
      "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fwebdav%2Fjianguoyun",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "PROPFIND",
          path: "magic-resume/manifest.json",
          username: "account@example.test",
          password: "app-password",
        }),
      },
    ));
    assert.equal(proxied.status, 207);
    assert.equal(await proxied.text(), "<multistatus/>");
    assert.deepEqual(upstreamCalls, [
      "https://dav.jianguoyun.com/dav/magic-resume/manifest.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the API bundle contains no Cloudflare dependency, source path, or test secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-faas-scan-"));
  try {
    const bundlePath = await buildApiFaas(directory);
    const bundle = await readFile(bundlePath, "utf8");

    for (const forbidden of [
      "workers.dev",
      "wrangler",
      "/Users/",
      "/workspace/",
      "sourceMappingURL",
      "sk-test-miaobi-secret",
    ]) {
      assert.equal(bundle.includes(forbidden), false, `bundle leaked ${forbidden}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two API builds of the same commit receive distinct nonce markers", async () => {
  const firstDirectory = await mkdtemp(join(tmpdir(), "magic-resume-faas-nonce-a-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "magic-resume-faas-nonce-b-"));
  const gitCommit = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
  try {
    await buildApiFaas(firstDirectory, { gitCommit });
    await buildApiFaas(secondDirectory, { gitCommit });
    const first = JSON.parse(await readFile(join(firstDirectory, "api-faas.meta.json"), "utf8"));
    const second = JSON.parse(await readFile(join(secondDirectory, "api-faas.meta.json"), "utf8"));
    assert.match(first.buildMarker, new RegExp(`^${gitCommit}\\.[0-9a-f]{64}$`));
    assert.match(second.buildMarker, new RegExp(`^${gitCommit}\\.[0-9a-f]{64}$`));
    assert.notEqual(first.buildMarker, second.buildMarker);
  } finally {
    await Promise.all([
      rm(firstDirectory, { recursive: true, force: true }),
      rm(secondDirectory, { recursive: true, force: true }),
    ]);
  }
});
