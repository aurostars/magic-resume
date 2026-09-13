import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  getApiRequestUrl,
  getPublicAssetUrl,
  getRuntimeConfig,
} from "../src/config/runtime-endpoints";

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  }
});

function injectRuntime(config: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __MAGIC_RESUME_RUNTIME__: config },
  });
}

test("default runtime keeps API and public asset paths root-relative", () => {
  Reflect.deleteProperty(globalThis, "window");

  assert.deepEqual(getRuntimeConfig(), {
    platform: "default",
    apiFunctionUrl: null,
    assetBaseUrl: null,
  });
  assert.equal(getApiRequestUrl("/api/grammar"), "/api/grammar");
  assert.equal(getPublicAssetUrl("/avatar.png"), "/avatar.png");
});

test("Miaobi runtime routes API paths through the injected HTTPS function URL", () => {
  injectRuntime({
    platform: "miaobi",
    apiFunctionUrl:
      "https://magic.solutionsuite.cn/api/faas/grammar-id?tenant=resume#ignored",
    assetBaseUrl: "https://static.solutionsuite.cn/magic-resume/#ignored",
  });

  assert.deepEqual(getRuntimeConfig(), {
    platform: "miaobi",
    apiFunctionUrl:
      "https://magic.solutionsuite.cn/api/faas/grammar-id?tenant=resume",
    assetBaseUrl: "https://static.solutionsuite.cn/magic-resume/",
  });
  assert.equal(
    getApiRequestUrl("/api/grammar"),
    "https://magic.solutionsuite.cn/api/faas/grammar-id?tenant=resume&__path=%2Fapi%2Fgrammar",
  );
  assert.equal(
    getPublicAssetUrl("/avatar.png"),
    "https://static.solutionsuite.cn/magic-resume/avatar.png",
  );
});

test("Miaobi API path replaces an existing __path without dropping other query parameters", () => {
  injectRuntime({
    platform: "miaobi",
    apiFunctionUrl:
      "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=old",
    assetBaseUrl: null,
  });

  assert.equal(
    getApiRequestUrl("/api/resume-import"),
    "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=%2Fapi%2Fresume-import",
  );
});

test("Miaobi rejects missing or Cloudflare runtime endpoints without exposing values", () => {
  for (const apiFunctionUrl of [
    null,
    "https://private-worker.workers.dev/path?token=secret",
  ]) {
    injectRuntime({
      platform: "miaobi",
      apiFunctionUrl,
      assetBaseUrl: null,
    });

    assert.throws(
      () => getApiRequestUrl("/api/grammar"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid runtime endpoint configuration");
        assert.doesNotMatch(error.message, /worker|secret|password|private/);
        return true;
      },
    );
  }
});

test("invalid or non-HTTPS runtime endpoints are rejected without exposing their values", () => {
  const secrets = [
    "http://user:password@example.test/functions?token=api-secret",
    "not-a-url-with-private-value",
  ];

  for (const secret of secrets) {
    injectRuntime({
      platform: "miaobi",
      apiFunctionUrl: secret,
      assetBaseUrl: "https://static.solutionsuite.cn/",
    });

    assert.throws(
      () => getRuntimeConfig(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Invalid runtime endpoint configuration");
        assert.doesNotMatch(error.message, /password|api-secret|private-value/);
        return true;
      },
    );
  }
});
