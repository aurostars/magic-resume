import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { buildApiFaas } from "../scripts/miaobi/build-faas";

const require = createRequire(import.meta.url);

test("the API build emits a standalone CommonJS FaaS handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "magic-resume-faas-"));
  try {
    const bundlePath = await buildApiFaas(directory, { buildMarker: "commit-59a06b5c2c12" });
    assert.equal(bundlePath, join(directory, "api-faas.cjs"));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "api-faas.meta.json"), "utf8")), {
      schemaVersion: 1,
      buildMarker: "commit-59a06b5c2c12",
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
    assert.equal(notFound.headers.get("X-Magic-Resume-Build"), "commit-59a06b5c2c12");
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
