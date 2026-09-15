import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deployMiaobi as deployMiaobiProduction,
  type MiaobiDeploymentState,
} from "../scripts/miaobi/deploy";
import type { GitHubPagesPublication } from "../scripts/miaobi/publish-github-pages";
import type { MagicBuilderRunner } from "../scripts/miaobi/types";

const COMMIT = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
const BUILD_NONCE = "0123456789abcdef0123456789abcdef";
const BUILD_MARKER = `${COMMIT}.${BUILD_NONCE}`;
const NOW = new Date("2026-09-13T16:46:00.000Z");
const RELEASE_ID = "59a06b5c2c12-20260913164600";
const PAGES_BASE_URL = "https://aurostars.github.io/magic-resume/";
const LOCK_LEASE_MS = 120_000;

function deployMiaobi(
  options: Parameters<typeof deployMiaobiProduction>[0],
): ReturnType<typeof deployMiaobiProduction> {
  return deployMiaobiProduction({
    publishPages: async ({ sourceCommit, releaseId }): Promise<GitHubPagesPublication> => ({
      manifest: {
        schemaVersion: 1,
        provider: "github-pages",
        sourceCommit,
        releaseId,
        createdAt: options.now.toISOString(),
        baseUrl: PAGES_BASE_URL,
        files: {},
      },
      pagesCommit: "a".repeat(40),
      pagesBaseUrl: PAGES_BASE_URL,
      releaseManifestUrl: `${PAGES_BASE_URL}releases/${sourceCommit}/manifest.json`,
    }),
    verifyPages: async () => undefined,
    ...options,
  });
}

type FakeLockTimer = {
  callback: () => void | Promise<void>;
  unref: () => void;
};

class FakeLockClock {
  current = Date.now();
  readonly timers = new Set<FakeLockTimer>();
  unrefCount = 0;

  now = () => this.current;

  setInterval = (callback: () => void | Promise<void>): FakeLockTimer => {
    const timer = {
      callback,
      unref: () => { this.unrefCount += 1; },
    };
    this.timers.add(timer);
    return timer;
  };

  clearInterval = (timer: unknown): void => {
    this.timers.delete(timer as FakeLockTimer);
  };

  async advance(milliseconds: number): Promise<void> {
    this.current += milliseconds;
    for (const timer of [...this.timers]) await timer.callback();
  }

  stop(): void {
    this.timers.clear();
  }
}

type Stage = "asset" | "api" | "web" | "page";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "magic-resume-deploy-"));
  await mkdir(join(root, "dist/miaobi/client/assets"), { recursive: true });
  await writeFile(join(root, "dist/miaobi/client/assets/app.js"), "console.log('app')");
  await writeFile(
    join(root, "dist/miaobi/client/index.html"),
    '<!doctype html><html><body><script type="module" src="https://miaobi.invalid/__ASSET_BASE__/app.js"></script></body></html>',
  );
  const apiBundle = "module.exports=()=>new Response()\n";
  await writeFile(join(root, "dist/miaobi/api-faas.cjs"), apiBundle);
  await writeFile(join(root, "dist/miaobi/api-faas.meta.json"), JSON.stringify({
    schemaVersion: 1,
    gitCommit: COMMIT,
    buildMarker: BUILD_MARKER,
    bundleSha256: createHash("sha256").update(apiBundle).digest("hex"),
  }));
  return root;
}

function fakeRunner(events: string[], failAt?: Stage, platformOrigin?: string): MagicBuilderRunner {
  let upload = 0;
  return {
    platformOrigin,
    async run(args) {
      if (args[0] === "file") {
        events.push("asset");
        if (failAt === "asset") throw new Error("credential=asset-secret");
        upload += 1;
        const key = args[args.indexOf("--key") + 1];
        return { stdout: JSON.stringify({ id: `upload-${upload}`, url: `https://tos.example.test/${key}` }), stderr: "" };
      }
      const stage = args[0] === "page" ? "page" : args.includes("magic-resume-api") || args.includes("api-old") ? "api" : "web";
      events.push(stage);
      if (failAt === stage) throw new Error(`token=${stage}-secret`);
      const origin = platformOrigin ?? "https://magic.solutionsuite.cn";
      const response = stage === "api"
        ? { id: "api-new", faas_url: `${origin}/api/faas/api-new` }
        : stage === "web"
          ? { id: "web-new", faas_url: `${origin}/api/faas/web-new` }
          : { id: "vv6BtLE8MTR", html_box_url: `${origin}/html-box/vv6BtLE8MTR` };
      return { stdout: JSON.stringify(response), stderr: "" };
    },
  };
}

function validPriorState(): MiaobiDeploymentState {
  return {
    schemaVersion: 2,
    apiBuildMarker: BUILD_MARKER,
    releaseId: "59a06b5c2c12-20260912000000",
    apiFaasId: "api-old",
    apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-old",
    webFaasId: "web-old",
    webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-old",
    pageId: "vv6BtLE8MTR",
    deployedAt: "2026-09-12T00:00:00.000Z",
  };
}

function validPagesState(): MiaobiDeploymentState {
  return {
    ...validPriorState(),
    schemaVersion: 3,
    assetProvider: "github-pages",
    pagesCommit: "a".repeat(40),
    pagesBaseUrl: PAGES_BASE_URL,
    releaseManifestUrl: `${PAGES_BASE_URL}releases/${COMMIT}/manifest.json`,
  } as MiaobiDeploymentState;
}

function healthyResponse(
  input: RequestInfo | URL,
  apiId = "api-new",
  releaseId = RELEASE_ID,
  platformOrigin = "https://magic.solutionsuite.cn",
  buildMarker = BUILD_MARKER,
): Response {
  const url = String(input);
  if (url.includes(`/api/faas/${apiId}?`)) {
    return Response.json(
      { error: "Not found", code: "notFound" },
      { status: 404, headers: {
        "X-Magic-Resume-Faas": "magic-resume-api",
        "X-Magic-Resume-Build": buildMarker,
      } },
    );
  }
  const runtime = {
    platform: "miaobi",
    apiFunctionUrl: `${platformOrigin}/api/faas/${apiId}`,
    assetBaseUrl: PAGES_BASE_URL,
  };
  return new Response(
    `<!doctype html><script>window.__MAGIC_RESUME_RUNTIME__=${JSON.stringify(runtime)}</script>`,
    { headers: { "X-Magic-Resume-Faas": "magic-resume-web" } },
  );
}

async function inFixture(run: (root: string) => Promise<void>) {
  const root = await fixture();
  const previousCwd = process.cwd();
  const previousFetch = globalThis.fetch;
  process.chdir(root);
  try {
    await run(root);
  } finally {
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
}

async function generationFiles(root: string, directory: ".miaobi/states" | ".miaobi-recovery/pending"): Promise<string[]> {
  return (await readdir(join(root, directory)))
    .filter((name) => /^[1-9]\d*-[0-9a-f]{32}\.json$/.test(name))
    .sort((left, right) => Number(left.split("-", 1)[0]) - Number(right.split("-", 1)[0]));
}

async function authoritativeState(root: string): Promise<{
  deployment: MiaobiDeploymentState;
  generation: number;
  ownerToken: string;
  resolvedGeneration: number;
  resolvedOwnerToken: string;
}> {
  const files = await generationFiles(root, ".miaobi/states");
  assert.ok(files.length > 0, "expected an immutable committed state");
  return JSON.parse(await readFile(join(root, ".miaobi/states", files.at(-1)!), "utf8"));
}

async function pendingRecords(root: string): Promise<Array<{
  generation: number;
  ownerToken: string;
  pending: { deployment: MiaobiDeploymentState; page: { id: string; artifactPath: string; sha256: string } };
}>> {
  const files = await generationFiles(root, ".miaobi-recovery/pending");
  return Promise.all(files.map(async (name) => JSON.parse(
    await readFile(join(root, ".miaobi-recovery/pending", name), "utf8"),
  )));
}

async function onlyPendingRecord(root: string): Promise<Awaited<ReturnType<typeof pendingRecords>>[number]> {
  const records = await pendingRecords(root);
  assert.equal(records.length, 1, "expected one immutable pending record");
  return records[0];
}

async function pagePhaseRecords(root: string, phase: "page-inflight" | "page-confirmed"): Promise<Array<{
  generation: number;
  ownerToken: string;
  pending: { phase: string; deployment: MiaobiDeploymentState };
}>> {
  const directory = join(root, `.miaobi-recovery/${phase}`);
  const files = (await readdir(directory))
    .filter((name) => /^[1-9]\d*-[0-9a-f]{32}\.json$/.test(name));
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

test("fails before reserving a generation or invoking the CLI when directory sync is unsupported", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const probe = await open(root);
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    prototype.sync = async function (this: typeof probe): Promise<void> {
      if ((await this.stat()).isDirectory()) {
        throw Object.assign(new Error("directory sync unsupported"), { code: "EINVAL" });
      }
      await originalSync.call(this);
    };
    const events: string[] = [];
    try {
      await assert.rejects(
        deployMiaobi({
          runner: fakeRunner(events),
          gitCommit: COMMIT,
          now: NOW,
          fetch: async (input) => healthyResponse(input),
        }),
        (error: unknown) => (error as { code?: string }).code === "MIAOBI_DURABILITY_UNSUPPORTED",
      );
    } finally {
      prototype.sync = originalSync;
    }

    assert.deepEqual(events, []);
    assert.deepEqual(await readdir(join(root, ".miaobi-recovery/generations")), []);
    assert.deepEqual(await generationFiles(root, ".miaobi-recovery/pending"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-inflight"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-confirmed"), []);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);
  });
});

test("fails before any record or remote side effect when page-inflight directory sync is unsupported", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const pageInflightDirectory = join(root, ".miaobi-recovery/page-inflight");
    await mkdir(pageInflightDirectory, { recursive: true, mode: 0o700 });
    const pageInflightIdentity = await stat(pageInflightDirectory);
    const probe = await open(root);
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    prototype.sync = async function (this: typeof probe): Promise<void> {
      const metadata = await this.stat();
      if (metadata.dev === pageInflightIdentity.dev && metadata.ino === pageInflightIdentity.ino) {
        throw Object.assign(new Error("page-inflight directory sync unsupported"), { code: "EINVAL" });
      }
      await originalSync.call(this);
    };
    const events: string[] = [];
    try {
      await assert.rejects(
        deployMiaobi({
          runner: fakeRunner(events),
          gitCommit: COMMIT,
          now: NOW,
          fetch: async (input) => healthyResponse(input),
        }),
        (error: unknown) => (error as { code?: string }).code === "MIAOBI_DURABILITY_UNSUPPORTED",
      );
    } finally {
      prototype.sync = originalSync;
    }

    assert.deepEqual(events, []);
    assert.deepEqual(await readdir(join(root, ".miaobi-recovery/generations")), []);
    assert.deepEqual(await generationFiles(root, ".miaobi-recovery/pending"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-inflight"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-confirmed"), []);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);
  });
});

test("fails before any record or remote side effect when states directory sync is unsupported", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const statesDirectory = join(root, ".miaobi/states");
    await mkdir(statesDirectory, { recursive: true, mode: 0o700 });
    const statesIdentity = await stat(statesDirectory);
    const probe = await open(root);
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    prototype.sync = async function (this: typeof probe): Promise<void> {
      const metadata = await this.stat();
      if (metadata.dev === statesIdentity.dev && metadata.ino === statesIdentity.ino) {
        throw Object.assign(new Error("states directory sync unsupported"), { code: "EINVAL" });
      }
      await originalSync.call(this);
    };
    const events: string[] = [];
    try {
      await assert.rejects(
        deployMiaobi({
          runner: fakeRunner(events),
          gitCommit: COMMIT,
          now: NOW,
          fetch: async (input) => healthyResponse(input),
        }),
        (error: unknown) => (error as { code?: string }).code === "MIAOBI_DURABILITY_UNSUPPORTED",
      );
    } finally {
      prototype.sync = originalSync;
    }

    assert.deepEqual(events, []);
    assert.deepEqual(await readdir(join(root, ".miaobi-recovery/generations")), []);
    assert.deepEqual(await generationFiles(root, ".miaobi-recovery/pending"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-inflight"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-confirmed"), []);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);
  });
});

test("revalidates directory sync capability after the recovery directory identity changes", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      fetch: async (input) => healthyResponse(input),
    });
    const statesBefore = await generationFiles(root, ".miaobi/states");
    await rename(join(root, ".miaobi-recovery"), join(root, ".miaobi-recovery-replaced"));
    await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
    const replacement = await stat(join(root, ".miaobi-recovery"));

    const probe = await open(root);
    const prototype = Object.getPrototypeOf(probe) as { sync: typeof probe.sync };
    const originalSync = prototype.sync;
    await probe.close();
    prototype.sync = async function (this: typeof probe): Promise<void> {
      const metadata = await this.stat();
      if (metadata.dev === replacement.dev && metadata.ino === replacement.ino) {
        throw Object.assign(new Error("replacement directory sync unsupported"), { code: "EINVAL" });
      }
      await originalSync.call(this);
    };
    const events: string[] = [];
    const nextNow = new Date("2026-09-13T16:47:00.000Z");
    try {
      await assert.rejects(
        deployMiaobi({
          runner: fakeRunner(events),
          gitCommit: COMMIT,
          now: nextNow,
          fetch: async (input) => healthyResponse(input, "api-new", "59a06b5c2c12-20260913164700"),
        }),
        (error: unknown) => (error as { code?: string }).code === "MIAOBI_DURABILITY_UNSUPPORTED",
      );
    } finally {
      prototype.sync = originalSync;
    }

    assert.deepEqual(events, []);
    assert.deepEqual(await readdir(join(root, ".miaobi-recovery/generations")), []);
    assert.deepEqual(await generationFiles(root, ".miaobi-recovery/pending"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-inflight"), []);
    assert.deepEqual(await pagePhaseRecords(root, "page-confirmed"), []);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), statesBefore);
  });
});

test("publishes assets, API, Web, checks both URLs, then switches the page and atomically saves state", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    globalThis.fetch = async (input, init) => {
      assert.equal(init?.redirect, "error");
      const url = String(input);
      events.push(url.includes("/api/faas/api-new?") ? "health-api" : "health-web");
      return healthyResponse(input);
    };

    const state = await deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW });
    assert.deepEqual(events, ["api", "web", "health-api", "health-web", "page"]);
    assert.deepEqual(state, {
      schemaVersion: 3,
      assetProvider: "github-pages",
      pagesCommit: "a".repeat(40),
      pagesBaseUrl: PAGES_BASE_URL,
      releaseManifestUrl: `${PAGES_BASE_URL}releases/${COMMIT}/manifest.json`,
      apiBuildMarker: BUILD_MARKER,
      releaseId: RELEASE_ID,
      apiFaasId: "api-new",
      apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-new",
      webFaasId: "web-new",
      webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-new",
      pageId: "vv6BtLE8MTR",
      deployedAt: NOW.toISOString(),
    });
    assert.deepEqual((await authoritativeState(root)).deployment, state);
    assert.deepEqual(await generationFiles(root, ".miaobi-recovery/pending"), []);
    assert.equal((await readdir(join(root, ".miaobi/states"))).some((name) => name.includes(".tmp-")), false);

    const page = await readFile(join(root, "dist/miaobi/page.html"), "utf8");
    assert.match(page, /^<!doctype html><meta charset="utf-8"><script>location\.replace\("https:\/\/magic\.solutionsuite\.cn\/api\/faas\/web-new"\)<\/script><a href="https:\/\/magic\.solutionsuite\.cn\/api\/faas\/web-new">/);
    assert.doesNotMatch(page, /workers\.dev|cloudflare/i);
  });
});

test("rejects untrusted or ID-mismatched FaaS publication responses before health checks", { concurrency: false }, async (context) => {
  const invalid = [
    { id: "", faas_url: "https://magic.solutionsuite.cn/api/faas/" },
    { id: "api-new", faas_url: "https://magic.solutionsuite.cn/api/faas/other" },
    { id: "api-new", faas_url: "https://evil.workers.dev/api/faas/api-new" },
    { id: "api-new", faas_url: "https://127.0.0.1/api/faas/api-new" },
    { id: "api-new", faas_url: "https://10.0.0.1/api/faas/api-new" },
    { id: "api-new", faas_url: "https://example.test/api/faas/api-new" },
  ];
  for (const response of invalid) {
    await context.test(JSON.stringify(response), { concurrency: false }, async () => {
      await inFixture(async () => {
        const events: string[] = [];
        let fetched = false;
        globalThis.fetch = async () => {
          fetched = true;
          return new Response("should-not-fetch");
        };
        const base = fakeRunner(events);
        const runner: MagicBuilderRunner = {
          async run(args) {
            if (args[0] === "faas" && args.includes("magic-resume-api")) {
              events.push("api");
              return { stdout: JSON.stringify(response), stderr: "" };
            }
            return base.run(args);
          },
        };
        await assert.rejects(
          deployMiaobi({ runner, gitCommit: COMMIT, now: NOW }),
          (error: unknown) => (error as Error).message === "MIAOBI_INVALID_RESPONSE",
        );
        assert.equal(fetched, false);
        assert.equal(events.includes("page"), false);
      });
    });
  }
});

test("rejects mismatched or untrusted page responses without committing state", { concurrency: false }, async (context) => {
  const invalid = [
    {
      id: "wrong-page",
      html_box_url: "https://magic.solutionsuite.cn/html-box/wrong-page",
    },
    {
      id: "vv6BtLE8MTR",
      html_box_url: "https://evil.example/html-box/vv6BtLE8MTR",
    },
  ];
  for (const response of invalid) {
    await context.test(JSON.stringify(response), { concurrency: false }, async () => {
      await inFixture(async (root) => {
        const events: string[] = [];
        const base = fakeRunner(events);
        const runner: MagicBuilderRunner = {
          async run(args) {
            if (args[0] === "page") {
              events.push("page");
              return { stdout: JSON.stringify(response), stderr: "" };
            }
            return base.run(args);
          },
        };
        globalThis.fetch = async (input) => healthyResponse(input);

        await assert.rejects(
          deployMiaobi({ runner, gitCommit: COMMIT, now: NOW }),
          (error: unknown) => (error as Error).message === "MIAOBI_INVALID_RESPONSE",
        );
        await assert.rejects(readFile(join(root, ".miaobi/deployment.json"), "utf8"));
      });
    });
  }
});

for (const failedStage of ["api", "web"] as const) {
  test(`${failedStage} failure prevents page publication and exposes only a safe code`, { concurrency: false }, async () => {
    await inFixture(async () => {
      const events: string[] = [];
      globalThis.fetch = async () => new Response("should-not-matter");
      await assert.rejects(
        deployMiaobi({ runner: fakeRunner(events, failedStage), gitCommit: COMMIT, now: NOW }),
        (error: unknown) => {
          assert.match(String((error as Error).message), /^MIAOBI_[A-Z_]+$/);
          assert.doesNotMatch(String((error as Error).message), /secret|credential|token/i);
          return true;
        },
      );
      assert.equal(events.includes("page"), false);
    });
  });
}

test("health checks reject stale API/Web identity and runtime release markers", { concurrency: false }, async (context) => {
  const invalidWebBodies = [
    healthyResponse("https://magic.solutionsuite.cn/api/faas/web-new", "api-old").text(),
    healthyResponse("https://magic.solutionsuite.cn/api/faas/web-new", "api-new").text()
      .then((body) => body.replace(PAGES_BASE_URL, "https://aurostars.github.io/magic-resume-other/")),
  ];
  for (const pendingBody of invalidWebBodies) {
    const body = await pendingBody;
    await context.test(body, { concurrency: false }, async () => {
      await inFixture(async () => {
        const events: string[] = [];
        globalThis.fetch = async (input, init) => {
          assert.equal(init?.redirect, "error");
          if (String(input).includes("/api/faas/api-new?")) {
            return Response.json(
              { code: "notFound" },
              { status: 404, headers: {
        "X-Magic-Resume-Faas": "magic-resume-api",
        "X-Magic-Resume-Build": BUILD_MARKER,
      } },
            );
          }
          return new Response(body, { headers: { "X-Magic-Resume-Faas": "magic-resume-web" } });
        };
        await assert.rejects(
          deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
          (error: unknown) => (error as Error).message === "MIAOBI_HEALTH_FAILED",
        );
        assert.equal(events.includes("page"), false);
      });
    });
  }
});

test("health checks reject a forged API 404 without the FaaS identity marker", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    globalThis.fetch = async () => Response.json({ code: "notFound" }, { status: 404 });
    await assert.rejects(
      deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_HEALTH_FAILED",
    );
    assert.equal(events.includes("page"), false);
  });
});

test("one health deadline aborts while waiting for response headers", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    let aborted = false;
    const fetchWithHangingHeaders: typeof fetch = async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("missing deadline")), 100);
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(fallback);
          reject(init.signal?.reason);
        }, { once: true });
      });
    };
    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner(events),
        gitCommit: COMMIT,
        now: NOW,
        fetch: fetchWithHangingHeaders,
        healthTimeoutMs: 10,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_HEALTH_FAILED",
    );
    assert.equal(aborted, true);
    assert.equal(events.includes("page"), false);
  });
});

test("one health deadline aborts while waiting for the response body", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    let calls = 0;
    let aborted = false;
    const fetchWithHangingBody: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) return healthyResponse(input);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const fallback = setTimeout(() => controller.error(new Error("missing deadline")), 100);
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            clearTimeout(fallback);
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      });
      return new Response(body, { headers: { "X-Magic-Resume-Faas": "magic-resume-web" } });
    };
    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner(events),
        gitCommit: COMMIT,
        now: NOW,
        fetch: fetchWithHangingBody,
        healthTimeoutMs: 10,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_HEALTH_FAILED",
    );
    assert.equal(aborted, true);
    assert.equal(events.includes("page"), false);
  });
});

test("a health failure neither switches the page nor leaks its response body", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    globalThis.fetch = async (input) => {
      events.push(String(input).includes("magic.solutionsuite.cn/api/faas/api") ? "health-api" : "health-web");
      return new Response("credential=health-body-secret", { status: 503 });
    };
    await assert.rejects(
      deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
      (error: unknown) => {
        assert.equal((error as Error).message, "MIAOBI_HEALTH_FAILED");
        assert.doesNotMatch(String(error), /health-body-secret|credential/i);
        return true;
      },
    );
    assert.equal(events.includes("page"), false);
  });
});

test("a pending commit failure prevents the final page switch", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner(events),
        gitCommit: COMMIT,
        now: NOW,
        transactionHook: async ({ point }) => {
          if (point !== "before-pending-commit") return;
          await rename(join(root, ".miaobi-recovery/pending"), join(root, ".miaobi-recovery/pending-displaced"));
          await mkdir(join(root, ".miaobi-recovery/pending"), { mode: 0o700 });
        },
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );
    assert.equal(events.includes("page"), false);
  });
});

test("a page update failure leaves the prior deployment state byte-for-byte intact", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const priorState: MiaobiDeploymentState = {
      schemaVersion: 2,
      apiBuildMarker: BUILD_MARKER,
      releaseId: "59a06b5c2c12-20260912000000",
      apiFaasId: "api-old",
      apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-old",
      webFaasId: "web-old",
      webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-old",
      pageId: "vv6BtLE8MTR",
      deployedAt: "2026-09-12T00:00:00.000Z",
    };
    const prior = `${JSON.stringify(priorState)}\n`;
    await mkdir(join(root, ".miaobi"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".miaobi/deployment.json"), prior);
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({ runner: fakeRunner([], "page"), gitCommit: COMMIT, now: NOW }),
    );
    assert.equal(await readFile(join(root, ".miaobi/deployment.json"), "utf8"), prior);
  });
});

test("rejects malformed prior deployment state before passing any ID to the CLI", { concurrency: false }, async (context) => {
  const invalidStates: unknown[] = [
    { ...validPriorState(), pageId: "attacker-page" },
    { ...validPriorState(), apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/other" },
    { ...validPriorState(), webFaasId: "" },
    { ...validPriorState(), releaseId: "prior-release" },
    { ...validPriorState(), deployedAt: "not-a-date" },
    { ...validPriorState(), extra: "unexpected" },
    { ...validPagesState(), assetProvider: "tos" },
    { ...validPagesState(), pagesCommit: "short" },
    { ...validPagesState(), pagesBaseUrl: "https://evil.example/magic-resume/" },
    { ...validPagesState(), releaseManifestUrl: `${PAGES_BASE_URL}releases/${"b".repeat(40)}/manifest.json` },
  ];
  for (const value of invalidStates) {
    await context.test(JSON.stringify(value), { concurrency: false }, async () => {
      await inFixture(async (root) => {
        await mkdir(join(root, ".miaobi"), { mode: 0o700 });
        await writeFile(join(root, ".miaobi/deployment.json"), JSON.stringify(value));
        let calls = 0;
        const runner: MagicBuilderRunner = { async run() { calls += 1; throw new Error("must not run"); } };
        await assert.rejects(
          deployMiaobi({ runner, gitCommit: COMMIT, now: NOW }),
          (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
        );
        assert.equal(calls, 0);
      });
    });
  }
});

test("rejects symlinked state directories and state files before publication", { concurrency: false }, async (context) => {
  await context.test("directory symlink", { concurrency: false }, async () => {
    await inFixture(async (root) => {
      const target = join(root, "state-target");
      await mkdir(target);
      await symlink(target, join(root, ".miaobi"), "dir");
      let calls = 0;
      await assert.rejects(
        deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
        (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
      );
      assert.equal(calls, 0);
    });
  });
  await context.test("state file symlink", { concurrency: false }, async () => {
    await inFixture(async (root) => {
      await mkdir(join(root, ".miaobi"), { mode: 0o700 });
      const target = join(root, "outside-state.json");
      await writeFile(target, JSON.stringify(validPriorState()));
      await symlink(target, join(root, ".miaobi/deployment.json"));
      let calls = 0;
      await assert.rejects(
        deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
        (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
      );
      assert.equal(calls, 0);
    });
  });
});

test("creates trusted 0700 transaction storage and exclusive 0600 immutable records", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });

    for (const directory of [
      ".miaobi",
      ".miaobi/states",
      ".miaobi-recovery",
      ".miaobi-recovery/pending",
      ".miaobi-recovery/page-inflight",
      ".miaobi-recovery/page-confirmed",
      ".miaobi-recovery/generations",
    ]) assert.equal((await stat(join(root, directory))).mode & 0o777, 0o700);
    const stateFiles = await generationFiles(root, ".miaobi/states");
    assert.equal(stateFiles.length, 1);
    assert.equal((await stat(join(root, ".miaobi/states", stateFiles[0]))).mode & 0o777, 0o600);
    for (const phase of ["page-inflight", "page-confirmed"] as const) {
      const records = await readdir(join(root, `.miaobi-recovery/${phase}`));
      assert.equal(records.length, 1);
      assert.equal((await stat(join(root, `.miaobi-recovery/${phase}`, records[0]))).mode & 0o777, 0o600);
    }
  });
});

test("detects a state-directory swap before immutable commit and preserves pending", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner([]),
        gitCommit: COMMIT,
        now: NOW,
        transactionHook: async ({ point }) => {
          if (point !== "before-state-commit") return;
          const stateDirectory = join(root, ".miaobi/states");
          await rename(stateDirectory, join(root, ".miaobi/states-original"));
          await mkdir(stateDirectory, { mode: 0o700 });
          await writeFile(join(stateDirectory, "attacker.json"), "attacker-state", { mode: 0o600 });
        },
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );
    assert.equal((await pendingRecords(root)).length, 1);
    assert.equal(await readFile(join(root, ".miaobi/states/attacker.json"), "utf8"), "attacker-state");
  });
});

test("holds an exclusive deployment lock before any publication", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    await mkdir(join(root, ".miaobi-recovery"), { recursive: true, mode: 0o700 });
    await writeFile(join(root, ".miaobi-recovery/deployment.lock"), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startedAt: new Date().toISOString(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    }), { mode: 0o600 });
    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not run"); } },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_LOCKED",
    );
    assert.equal(calls, 0);
  });
});

test("a rerun creates fresh FaaS resources and preserves prior rollback IDs", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const prior: MiaobiDeploymentState = {
      schemaVersion: 2,
      apiBuildMarker: BUILD_MARKER,
      releaseId: "59a06b5c2c12-20260912000000",
      apiFaasId: "api-old",
      apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-old",
      webFaasId: "web-old",
      webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-old",
      pageId: "vv6BtLE8MTR",
      deployedAt: "2026-09-12T00:00:00.000Z",
    };
    await mkdir(join(root, ".miaobi"), { recursive: true });
    await writeFile(join(root, ".miaobi/deployment.json"), JSON.stringify(prior));
    const calls: string[][] = [];
    const base = fakeRunner([]);
    const runner: MagicBuilderRunner = { async run(args) { calls.push(args); return base.run(args); } };
    globalThis.fetch = async (input) => healthyResponse(
      input,
      "api-new",
      "59a06b5c2c12-20260913164700",
    );

    await deployMiaobi({ runner, gitCommit: COMMIT, now: new Date("2026-09-13T16:47:00.000Z") });
    const faasCalls = calls.filter((args) => args[0] === "faas");
    assert.equal(faasCalls[0].includes("--id"), false);
    assert.ok(faasCalls[0].includes("--name") && faasCalls[0].includes("magic-resume-api"));
    assert.equal(faasCalls[1].includes("--id"), false);
    assert.ok(faasCalls[1].includes("--name") && faasCalls[1].includes("magic-resume-web"));
    assert.equal(prior.apiFaasId, "api-old");
    assert.equal(prior.webFaasId, "web-old");
    const pageCall = calls.find((args) => args[0] === "page");
    assert.ok(pageCall?.includes("--id") && pageCall.includes("vv6BtLE8MTR"));
  });
});


test("uses the runner's validated custom platform origin for CLI responses, health, and page redirect", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const origin = "https://magic.staging.example";
    const events: string[] = [];
    const fetched: string[] = [];
    const runner = fakeRunner(events, undefined, origin);
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      return healthyResponse(input, "api-new", RELEASE_ID, origin);
    };

    const state = await deployMiaobi({ runner, gitCommit: COMMIT, now: NOW });
    assert.equal(state.apiFaasUrl, `${origin}/api/faas/api-new`);
    assert.equal(state.webFaasUrl, `${origin}/api/faas/web-new`);
    assert.ok(fetched.every((url) => url.startsWith(origin)));
    assert.match(await readFile(join(root, "dist/miaobi/page.html"), "utf8"), /magic\.staging\.example/);
  });
});

test("rejects an untrusted runner platform origin before publication", { concurrency: false }, async (context) => {
  for (const origin of [
    "http://magic.example",
    "https://workers.dev",
    "https://tenant.workers.dev",
    "https://127.0.0.1",
    "https://user:pass@magic.example",
    "https://magic.example/path",
    "https://magic.example?query=1",
  ]) {
    await context.test(origin, { concurrency: false }, async () => {
      await inFixture(async () => {
        let calls = 0;
        const runner: MagicBuilderRunner = {
          platformOrigin: origin,
          async run() { calls += 1; throw new Error("must not run"); },
        };
        await assert.rejects(
          deployMiaobi({ runner, gitCommit: COMMIT, now: NOW }),
          (error: unknown) => (error as Error).message === "MIAOBI_PLATFORM_ORIGIN_INVALID",
        );
        assert.equal(calls, 0);
      });
    });
  }
});

test("keeps a confirmed page transaction when final state commit fails and recovers without republishing", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner([]),
        gitCommit: COMMIT,
        now: NOW,
        transactionHook: async ({ point }) => {
          if (point !== "before-state-commit") return;
          await rename(join(root, ".miaobi/states"), join(root, ".miaobi/states-failed"));
          await mkdir(join(root, ".miaobi/states"), { mode: 0o700 });
        },
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );
    const record = await onlyPendingRecord(root);
    const pending = record.pending;
    assert.equal(pending.page.id, "vv6BtLE8MTR");
    assert.equal(pending.page.artifactPath, "dist/miaobi/page.html");
    assert.equal(pending.page.sha256, createHash("sha256")
      .update(await readFile(join(root, pending.page.artifactPath)))
      .digest("hex"));

    const recoveryCalls: string[][] = [];
    const recoveryRunner: MagicBuilderRunner = {
      async run(args) {
        recoveryCalls.push(args);
        throw new Error("confirmed recovery must not call the remote API");
      },
    };
    const recovered = await deployMiaobi({ runner: recoveryRunner, gitCommit: COMMIT, now: NOW });
    assert.deepEqual(recovered, pending.deployment);
    assert.equal(recoveryCalls.length, 0);
    assert.equal((await pendingRecords(root)).length, 1);
    assert.deepEqual((await authoritativeState(root)).deployment, recovered);
  });
});

test("a successor may publish a prepared transaction that never entered the page API", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("simulated crash before page");
      },
    }));
    assert.equal((await pagePhaseRecords(root, "page-inflight")).length, 0);

    const calls: string[][] = [];
    const recovered = await deployMiaobi({
      runner: {
        async run(args) {
          calls.push(args);
          return {
            stdout: JSON.stringify({ id: "vv6BtLE8MTR", html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR" }),
            stderr: "",
          };
        },
      },
      gitCommit: COMMIT,
      now: NOW,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "page");
    assert.equal((await pagePhaseRecords(root, "page-confirmed")).length, 1);
    assert.deepEqual((await authoritativeState(root)).deployment, recovered);
  });
});

test("keeps an uncertain page barrier and never republishes a mutable artifact", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const base = fakeRunner(events);
    const uncertain: MagicBuilderRunner = {
      async run(args) {
        if (args[0] === "page") {
          events.push("page");
          return { stdout: "remote may have committed", stderr: "" };
        }
        return base.run(args);
      },
    };
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({ runner: uncertain, gitCommit: COMMIT, now: NOW }));
    const pending = (await onlyPendingRecord(root)).pending;
    await writeFile(join(root, pending.page.artifactPath), "tampered page");

    let recoveryCalls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: {
          async run() {
            recoveryCalls += 1;
            throw new Error("must not republish an uncertain page");
          },
        },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(recoveryCalls, 0);
    assert.equal((await pendingRecords(root)).length, 1);
  });
});

test("rejects API metadata built for a different commit before publication", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const metadataPath = join(root, "dist/miaobi/api-faas.meta.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.gitCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    metadata.buildMarker = `${metadata.gitCommit}.${BUILD_NONCE}`;
    await writeFile(metadataPath, JSON.stringify(metadata));
    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_BUILD_METADATA_INVALID",
    );
    assert.equal(calls, 0);
  });
});

test("rejects an older bundle nonce from the same commit before page publication", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    const oldMarker = `${COMMIT}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    globalThis.fetch = async (input) => healthyResponse(input, "api-new", RELEASE_ID, undefined, oldMarker);
    await assert.rejects(
      deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_HEALTH_FAILED",
    );
    assert.equal(events.includes("page"), false);
  });
});

test("reconciles the recovery anchor after the .miaobi directory is replaced", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const firstEvents: string[] = [];
    const base = fakeRunner(firstEvents);
    const firstRunner: MagicBuilderRunner = {
      async run(args) {
        const result = await base.run(args);
        if (args[0] === "page") {
          await rename(join(root, ".miaobi"), join(root, ".miaobi-replaced"));
        }
        return result;
      },
    };
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(
      deployMiaobi({ runner: firstRunner, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );

    const record = await onlyPendingRecord(root);
    const pending = record.pending;
    const recoveryPath = join(root, ".miaobi-recovery/pending", `${record.generation}-${record.ownerToken}.json`);
    assert.equal((await stat(join(root, ".miaobi-recovery"))).mode & 0o777, 0o700);
    assert.equal((await stat(recoveryPath)).mode & 0o777, 0o600);
    assert.equal(pending.apiBuildMarker, BUILD_MARKER);

    const calls: string[][] = [];
    const recovered = await deployMiaobi({
      runner: {
        async run(args) {
          calls.push(args);
          return {
            stdout: JSON.stringify({
              id: "vv6BtLE8MTR",
              html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR",
            }),
            stderr: "",
          };
        },
      },
      gitCommit: COMMIT,
      now: NOW,
    });
    assert.deepEqual(recovered, pending.deployment);
    assert.equal(calls.length, 0);
    assert.equal((await pendingRecords(root)).length, 1);
  });
});

test("rejects a pending artifact and matching attacker hash instead of switching it", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const base = fakeRunner(events);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for validation");
      },
    }));

    const record = await onlyPendingRecord(root);
    const recoveryPath = join(root, ".miaobi-recovery/pending", `${record.generation}-${record.ownerToken}.json`);
    const attackerPage = "<!doctype html><script>location='https://attacker.example'</script>";
    await writeFile(join(root, record.pending.page.artifactPath), attackerPage);
    record.pending.page.sha256 = createHash("sha256").update(attackerPage).digest("hex");
    await writeFile(recoveryPath, JSON.stringify(record));

    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_PENDING_INVALID",
    );
    assert.equal(calls, 0);
  });
});

test("reclaims stale empty and malformed single-file locks", { concurrency: false }, async (context) => {
  for (const body of ["", "not-json"]) {
    await context.test(body || "empty", { concurrency: false }, async () => {
      await inFixture(async (root) => {
        await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
        const lockPath = join(root, ".miaobi-recovery/deployment.lock");
        await writeFile(lockPath, body, { mode: 0o600 });
        const stale = new Date(Date.now() - 120_000);
        await utimes(lockPath, stale, stale);
        globalThis.fetch = async (input) => healthyResponse(input);
        const state = await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });
        assert.equal(state.pageId, "vv6BtLE8MTR");
      });
    });
  }
});

test("a recent live single-file lock remains exclusive", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
    await writeFile(join(root, ".miaobi-recovery/deployment.lock"), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "0123456789abcdef0123456789abcdef",
      startedAt: new Date().toISOString(),
      processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    }), { mode: 0o600 });
    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_LOCKED",
    );
    assert.equal(calls, 0);
  });
});

test("reclaims a stale heartbeat even when the recorded PID is alive and may have been reused", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
      const lockPath = join(root, ".miaobi-recovery/deployment.lock");
      const old = new Date(Date.now() - LOCK_LEASE_MS - 1);
      await writeFile(lockPath, JSON.stringify({
        schemaVersion: 1,
        pid: child.pid,
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        startedAt: old.toISOString(),
        processStartedAt: new Date(old.getTime() - 1000).toISOString(),
      }), { mode: 0o600 });
      await utimes(lockPath, old, old);
      globalThis.fetch = async (input) => healthyResponse(input);
      const state = await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });
      assert.equal(state.schemaVersion, 3);
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  });
});

test("reclaims an old lock after its owner PID exits", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const deadPid = child.pid;
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));

    await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
    const lockPath = join(root, ".miaobi-recovery/deployment.lock");
    const old = new Date(Date.now() - 120_000);
    await writeFile(lockPath, JSON.stringify({
      schemaVersion: 1,
      pid: deadPid,
      token: "cccccccccccccccccccccccccccccccc",
      startedAt: old.toISOString(),
      processStartedAt: new Date(old.getTime() - 1000).toISOString(),
    }), { mode: 0o600 });
    await utimes(lockPath, old, old);
    globalThis.fetch = async (input) => healthyResponse(input);
    const state = await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });
    assert.equal(state.schemaVersion, 3);
  });
});

test("migrates a strictly validated version 1 deployment state without mutating its FaaS IDs", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const legacy = { ...validPriorState(), schemaVersion: 1 };
    delete (legacy as { apiBuildMarker?: string }).apiBuildMarker;
    await mkdir(join(root, ".miaobi"), { mode: 0o700 });
    await writeFile(join(root, ".miaobi/deployment.json"), JSON.stringify(legacy));
    const calls: string[][] = [];
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input, "api-new", RELEASE_ID);
    const state = await deployMiaobi({
      runner: { async run(args) { calls.push(args); return base.run(args); } },
      gitCommit: COMMIT,
      now: NOW,
    });
    const faasCalls = calls.filter((args) => args[0] === "faas");
    assert.equal(faasCalls[0].includes("api-old"), false);
    assert.equal(faasCalls[1].includes("web-old"), false);
    assert.equal(state.schemaVersion, 3);
    assert.equal(state.apiBuildMarker, BUILD_MARKER);
  });
});

test("a legacy pending without a page phase fails closed after safe validation", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for recovery");
      },
    }));
    const record = await onlyPendingRecord(root);
    const currentPath = join(root, ".miaobi-recovery/pending", `${record.generation}-${record.ownerToken}.json`);
    const legacyPath = join(root, ".miaobi/deployment.pending.json");
    const legacy = structuredClone(record.pending) as any;
    legacy.schemaVersion = 1;
    delete legacy.phase;
    delete legacy.apiBuildMarker;
    legacy.deployment.schemaVersion = 1;
    delete legacy.deployment.apiBuildMarker;
    delete legacy.deployment.assetProvider;
    delete legacy.deployment.pagesCommit;
    delete legacy.deployment.pagesBaseUrl;
    delete legacy.deployment.releaseManifestUrl;
    await writeFile(legacyPath, JSON.stringify(legacy), { mode: 0o600 });
    await rm(currentPath);

    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not publish"); } },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(calls, 0);
    assert.equal((await readFile(legacyPath, "utf8")).length > 0, true);
  });
});

test("an unphased schema 2 generation pending is treated as an uncertain page result", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for migration fixture");
      },
    }));
    const record = await onlyPendingRecord(root) as any;
    const path = join(root, ".miaobi-recovery/pending", `${record.generation}-${record.ownerToken}.json`);
    record.pending.schemaVersion = 2;
    delete record.pending.phase;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });

    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not publish"); } },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(calls, 0);
    assert.equal((await readFile(path, "utf8")).length > 0, true);
  });
});

test("preserves a legacy pending whose marker disagrees with local API metadata", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for recovery");
      },
    }));
    const generated = await onlyPendingRecord(root);
    const generatedPath = join(root, ".miaobi-recovery/pending", `${generated.generation}-${generated.ownerToken}.json`);
    const pendingPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = structuredClone(generated.pending) as any;
    const forgedMarker = `${COMMIT}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    pending.schemaVersion = 1;
    delete pending.phase;
    pending.apiBuildMarker = forgedMarker;
    pending.deployment.schemaVersion = 1;
    pending.deployment.apiBuildMarker = forgedMarker;
    await writeFile(pendingPath, JSON.stringify(pending), { mode: 0o600 });
    await rm(generatedPath);

    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_PENDING_RECOVERY_REQUIRED",
    );
    assert.equal(calls, 0);
    assert.equal((await readFile(pendingPath, "utf8")).length > 0, true);
  });
});

test("preserves a legacy pending when API metadata cannot supply its marker", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    await mkdir(join(root, ".miaobi"), { mode: 0o700 });
    const legacyPath = join(root, ".miaobi/deployment.pending.json");
    const deployment = { ...validPriorState(), schemaVersion: 1 };
    delete (deployment as { apiBuildMarker?: string }).apiBuildMarker;
    await rm(join(root, "dist/miaobi/api-faas.meta.json"));
    const page = '<!doctype html><meta charset="utf-8"><script>location.replace("https://magic.solutionsuite.cn/api/faas/web-old")</script><a href="https://magic.solutionsuite.cn/api/faas/web-old">打开魔方简历</a>';
    await writeFile(legacyPath, JSON.stringify({
      schemaVersion: 1,
      status: "pending-page-commit",
      platformOrigin: "https://magic.solutionsuite.cn",
      deployment,
      page: {
        id: "vv6BtLE8MTR",
        artifactPath: "dist/miaobi/page.html",
        sha256: createHash("sha256").update(page).digest("hex"),
      },
    }), { mode: 0o600 });
    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_PENDING_RECOVERY_REQUIRED",
    );
    assert.equal(calls, 0);
    assert.equal((await readFile(legacyPath, "utf8")).length > 0, true);
  });
});

test("rejects release and API marker commit-prefix mismatches in state and pending", { concurrency: false }, async (context) => {
  await context.test("state", { concurrency: false }, async () => {
    await inFixture(async (root) => {
      await mkdir(join(root, ".miaobi"), { mode: 0o700 });
      await writeFile(join(root, ".miaobi/deployment.json"), JSON.stringify({
        ...validPriorState(),
        releaseId: "aaaaaaaaaaaa-20260912000000",
      }));
      let calls = 0;
      await assert.rejects(
        deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
        (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
      );
      assert.equal(calls, 0);
    });
  });
  await context.test("pending", { concurrency: false }, async () => {
    await inFixture(async (root) => {
      const base = fakeRunner([]);
      globalThis.fetch = async (input) => healthyResponse(input);
      await assert.rejects(deployMiaobi({
        runner: base,
        gitCommit: COMMIT,
        now: NOW,
        transactionHook: async ({ point }) => {
          if (point === "before-page-inflight") throw new Error("leave prepared for validation");
        },
      }));
      const record = await onlyPendingRecord(root);
      const pendingPath = join(root, ".miaobi-recovery/pending", `${record.generation}-${record.ownerToken}.json`);
      record.pending.deployment.releaseId = "aaaaaaaaaaaa-20260913164600";
      await writeFile(pendingPath, JSON.stringify(record));
      let calls = 0;
      await assert.rejects(
        deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
        (error: unknown) => (error as Error).message === "MIAOBI_PENDING_INVALID",
      );
      assert.equal(calls, 0);
      assert.equal((await readFile(pendingPath, "utf8")).length > 0, true);
    });
  });
});


test("an active owner refreshes its token-bound heartbeat and remains exclusive", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    let resolveOwner!: (result: { stdout: string; stderr: string }) => void;
    const blocked = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwner = resolve; });
    const owner = deployMiaobi({
      runner: { async run() { return blocked; } },
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
    });
    const ownerOutcome = owner.catch((error: unknown) => error as Error);
    while (clock.timers.size === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clock.unrefCount, 1);
    await clock.advance(LOCK_LEASE_MS + 10_000);
    const lockPath = join(root, ".miaobi-recovery/deployment.lock");
    for (let attempt = 0; attempt < 100 && (await stat(lockPath)).mtimeMs < clock.current - 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal((await stat(lockPath)).mtimeMs >= clock.current - 1, true);

    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not run"); } },
        gitCommit: COMMIT,
        now: NOW,
        lockClock: clock,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_LOCKED",
    );
    assert.equal(calls, 0);

    resolveOwner({ stdout: "invalid", stderr: "" });
    assert.ok((await ownerOutcome) instanceof Error);
    assert.equal(clock.timers.size, 0);
    await assert.rejects(readFile(join(root, ".miaobi-recovery/deployment.lock"), "utf8"));
  });
});

test("a superseded owner is fenced before its next remote side effect and preserves the successor transaction", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    const ownerAEvents: string[] = [];
    let ownerAKey = "";
    let resolveOwnerA!: (result: { stdout: string; stderr: string }) => void;
    const ownerABlocked = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwnerA = resolve; });
    const ownerA = deployMiaobi({
      runner: {
        async run(args) {
          ownerAEvents.push(args[0]);
          if (ownerAEvents.length > 1) throw new Error("superseded owner performed another remote call");
          ownerAKey = args[args.indexOf("--key") + 1];
          return ownerABlocked;
        },
      },
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
    });
    const ownerAOutcome = ownerA.catch((error: unknown) => error as Error);
    while (ownerAEvents.length === 0) await new Promise((resolve) => setImmediate(resolve));

    clock.current += LOCK_LEASE_MS + 10_000;
    const ownerBEvents: string[] = [];
    let resolveOwnerBPage!: (result: { stdout: string; stderr: string }) => void;
    const ownerBPageBlocked = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwnerBPage = resolve; });
    const ownerBRunner: MagicBuilderRunner = {
      async run(args) {
        if (args[0] === "file") {
          ownerBEvents.push("asset");
          const key = args[args.indexOf("--key") + 1];
          return { stdout: JSON.stringify({ id: `owner-b-upload-${ownerBEvents.length}`, url: `https://tos.example.test/${key}` }), stderr: "" };
        }
        if (args[0] === "page") {
          ownerBEvents.push("page");
          return ownerBPageBlocked;
        }
        const api = args.includes("magic-resume-api");
        ownerBEvents.push(api ? "api" : "web");
        const id = api ? "api-new" : "web-new";
        return { stdout: JSON.stringify({ id, faas_url: `https://magic.solutionsuite.cn/api/faas/${id}` }), stderr: "" };
      },
    };
    globalThis.fetch = async (input) => healthyResponse(
      input,
      "api-new",
      "59a06b5c2c12-20260913164700",
    );
    const ownerB = deployMiaobi({
      runner: ownerBRunner,
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      lockClock: clock,
    });
    while (!ownerBEvents.includes("page")) await new Promise((resolve) => setImmediate(resolve));

    const lockPath = join(root, ".miaobi-recovery/deployment.lock");
    const successorLock = await readFile(lockPath, "utf8");
    const successorPendingFiles = await generationFiles(root, ".miaobi-recovery/pending");
    assert.equal(successorPendingFiles.length, 1);
    const successorPendingPath = join(root, ".miaobi-recovery/pending", successorPendingFiles[0]);
    const successorPending = await readFile(successorPendingPath, "utf8");
    resolveOwnerA({ stdout: JSON.stringify({ id: "owner-a-upload", url: `https://tos.example.test/${ownerAKey}` }), stderr: "" });

    const ownerAError = await ownerAOutcome;
    assert.equal(ownerAError.message, "MIAOBI_OWNERSHIP_LOST");
    assert.deepEqual(ownerAEvents, ["faas"]);
    assert.equal(await readFile(lockPath, "utf8"), successorLock);
    assert.equal(await readFile(successorPendingPath, "utf8"), successorPending);

    resolveOwnerBPage({
      stdout: JSON.stringify({
        id: "vv6BtLE8MTR",
        html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR",
      }),
      stderr: "",
    });
    const ownerBState = await ownerB;
    assert.equal(ownerBState.releaseId, "59a06b5c2c12-20260913164700");
  });
});

test("losing ownership during page publication preserves pending and forbids the state commit", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    const events: string[] = [];
    const base = fakeRunner(events);
    let resolvePage!: (result: { stdout: string; stderr: string }) => void;
    const blockedPage = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolvePage = resolve; });
    const deployment = deployMiaobi({
      runner: {
        async run(args) {
          if (args[0] === "page") {
            events.push("page");
            return blockedPage;
          }
          return base.run(args);
        },
      },
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
      fetch: async (input) => healthyResponse(input),
    });
    const outcome = deployment.catch((error: unknown) => error as Error);
    while (!events.includes("page")) await new Promise((resolve) => setImmediate(resolve));
    const pendingFiles = await generationFiles(root, ".miaobi-recovery/pending");
    assert.equal(pendingFiles.length, 1);
    const pendingPath = join(root, ".miaobi-recovery/pending", pendingFiles[0]);
    const pendingBefore = await readFile(pendingPath, "utf8");

    const lockPath = join(root, ".miaobi-recovery/deployment.lock");
    await rm(lockPath);
    const successorLock = JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: "dddddddddddddddddddddddddddddddd",
      startedAt: new Date(clock.current).toISOString(),
      processStartedAt: new Date(clock.current - process.uptime() * 1000).toISOString(),
    });
    await writeFile(lockPath, successorLock, { mode: 0o600 });
    resolvePage({
      stdout: JSON.stringify({
        id: "vv6BtLE8MTR",
        html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR",
      }),
      stderr: "",
    });

    const error = await outcome;
    assert.equal(error.message, "MIAOBI_OWNERSHIP_LOST");
    assert.equal(await readFile(pendingPath, "utf8"), pendingBefore);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);
    assert.equal(await readFile(lockPath, "utf8"), successorLock);
  });
});

test("a foreign page-inflight barrier freezes every successor without another remote mutation", { concurrency: false, timeout: 10_000 }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    const ownerAEvents: string[] = [];
    const ownerABase = fakeRunner(ownerAEvents);
    let resolveOwnerAPage!: (result: { stdout: string; stderr: string }) => void;
    const ownerAPage = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwnerAPage = resolve; });
    const ownerA = deployMiaobi({
      runner: {
        async run(args) {
          if (args[0] === "page") {
            ownerAEvents.push("page");
            return ownerAPage;
          }
          return ownerABase.run(args);
        },
      },
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
      fetch: async (input) => healthyResponse(input),
    });
    const ownerAOutcome = ownerA.catch((error: unknown) => error as Error);
    while (!ownerAEvents.includes("page")) await new Promise((resolve) => setImmediate(resolve));
    const inflight = await pagePhaseRecords(root, "page-inflight");
    assert.equal(inflight.length, 1);
    assert.equal(inflight[0].pending.phase, "page-inflight");

    clock.stop();
    clock.current += LOCK_LEASE_MS + 10_000;
    for (const successor of ["B", "C"]) {
      let calls = 0;
      await assert.rejects(
        deployMiaobi({
          runner: { async run() { calls += 1; throw new Error(`owner ${successor} must not publish`); } },
          gitCommit: COMMIT,
          now: NOW,
          lockClock: clock,
        }),
        (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
      );
      assert.equal(calls, 0);
    }

    resolveOwnerAPage({
      stdout: JSON.stringify({ id: "vv6BtLE8MTR", html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR" }),
      stderr: "",
    });
    assert.equal((await ownerAOutcome).message, "MIAOBI_OWNERSHIP_LOST");
    assert.equal((await pagePhaseRecords(root, "page-inflight")).length, 1);
    assert.equal((await pagePhaseRecords(root, "page-confirmed")).length, 0);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);
  });
});

test("page success is durably confirmed before state commit", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    let observedConfirmed = false;
    const state = await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point !== "before-state-commit") return;
        const confirmed = await pagePhaseRecords(root, "page-confirmed");
        assert.equal(confirmed.length, 1);
        assert.equal(confirmed[0].pending.phase, "page-confirmed");
        assert.equal(confirmed[0].pending.deployment.releaseId, RELEASE_ID);
        observedConfirmed = true;
      },
    });
    assert.equal(observedConfirmed, true);
    assert.deepEqual((await authoritativeState(root)).deployment, state);
  });
});

test("state commit reports ownership loss after its immutable write on fresh, reconcile, and confirmed recovery paths", { concurrency: false }, async (context) => {
  for (const path of ["fresh", "reconcile", "confirmed-recovery"] as const) {
    await context.test(path, { concurrency: false }, async () => {
      await inFixture(async (root) => {
        globalThis.fetch = async (input) => healthyResponse(input);
        if (path !== "fresh") {
          await assert.rejects(deployMiaobi({
            runner: fakeRunner([]),
            gitCommit: COMMIT,
            now: NOW,
            transactionHook: async ({ point }) => {
              if (point === (path === "reconcile" ? "before-page-inflight" : "before-state-commit")) {
                throw new Error("prepare recovery path");
              }
            },
          }));
        }

        await assert.rejects(deployMiaobi({
          runner: fakeRunner([]),
          gitCommit: COMMIT,
          now: NOW,
          transactionHook: async ({ point }) => {
            if (point !== "after-state-write") return;
            const lockPath = join(root, ".miaobi-recovery/deployment.lock");
            await rm(lockPath);
            await writeFile(lockPath, JSON.stringify({ token: "b".repeat(32) }), { mode: 0o600 });
          },
        }), (error: unknown) => (error as Error).message === "MIAOBI_OWNERSHIP_LOST");
        assert.equal((await generationFiles(root, ".miaobi/states")).length, 1);
      });
    });
  }
});

test("a crash after remote page success but before confirmation remains permanently uncertain", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner([]),
        gitCommit: COMMIT,
        now: NOW,
        transactionHook: async ({ point }) => {
          if (point === "before-page-confirmation") throw new Error("simulated crash");
        },
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_DEPLOY_FAILED",
    );
    assert.equal((await pagePhaseRecords(root, "page-inflight")).length, 1);
    assert.equal((await pagePhaseRecords(root, "page-confirmed")).length, 0);
    assert.deepEqual(await generationFiles(root, ".miaobi/states"), []);

    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not publish"); } },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(calls, 0);
  });
});

test("a stopped heartbeat expires after the generous lease and can be recovered", { concurrency: false }, async () => {
  await inFixture(async () => {
    const clock = new FakeLockClock();
    let resolveOwner!: (result: { stdout: string; stderr: string }) => void;
    const blocked = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwner = resolve; });
    let ownerCalls = 0;
    const owner = deployMiaobi({
      runner: { async run() { ownerCalls += 1; return blocked; } },
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
    });
    const ownerOutcome = owner.catch((error: unknown) => error as Error);
    while (ownerCalls === 0) await new Promise((resolve) => setImmediate(resolve));
    clock.stop();
    clock.current += LOCK_LEASE_MS + 10_000;
    globalThis.fetch = async (input) => healthyResponse(
      input,
      "api-new",
      "59a06b5c2c12-20260913164700",
    );

    const recovered = await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      lockClock: clock,
    });
    assert.equal(recovered.schemaVersion, 3);

    resolveOwner({ stdout: "invalid", stderr: "" });
    assert.ok((await ownerOutcome) instanceof Error);
  });
});

test("generation allocation remains monotonic when its index directory is recreated", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    const first = await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });
    const firstAuthority = await authoritativeState(root);
    await rm(join(root, ".miaobi-recovery/generations"), { recursive: true });

    const second = await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      fetch: async (input) => healthyResponse(input, "api-new", "59a06b5c2c12-20260913164700"),
    });
    const secondAuthority = await authoritativeState(root);
    assert.equal(first.releaseId, RELEASE_ID);
    assert.equal(second.releaseId, "59a06b5c2c12-20260913164700");
    assert.ok(secondAuthority.generation > firstAuthority.generation);
    assert.deepEqual(secondAuthority.deployment, second);
  });
});

test("a crash-left token-scoped state temp does not block a later generation", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    globalThis.fetch = async (input) => healthyResponse(input);
    await deployMiaobi({ runner: fakeRunner([]), gitCommit: COMMIT, now: NOW });
    const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await writeFile(
      join(root, ".miaobi/states", `.2-${token}.json.tmp-${token}-00000000-0000-4000-8000-000000000000`),
      "partial",
      { mode: 0o600 },
    );

    const state = await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      fetch: async (input) => healthyResponse(input, "api-new", "59a06b5c2c12-20260913164700"),
    });
    assert.deepEqual((await authoritativeState(root)).deployment, state);
  });
});

test("a stale owner resuming pending commit cannot outrank the successor", { concurrency: false, timeout: 10_000 }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    let resumeOwnerA!: () => void;
    const ownerAGate = new Promise<void>((resolve) => { resumeOwnerA = resolve; });
    let ownerAReached!: () => void;
    const ownerAAtPending = new Promise<void>((resolve) => { ownerAReached = resolve; });
    const ownerA = deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
      fetch: async (input) => healthyResponse(input),
      transactionHook: async ({ point }) => {
        if (point !== "before-pending-commit") return;
        ownerAReached();
        await ownerAGate;
      },
    });
    const ownerAOutcome = ownerA.catch((error: unknown) => error as Error);
    await ownerAAtPending;

    clock.stop();
    clock.current += LOCK_LEASE_MS + 10_000;
    const ownerBState = await deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      lockClock: clock,
      fetch: async (input) => healthyResponse(input, "api-new", "59a06b5c2c12-20260913164700"),
    });
    resumeOwnerA();

    assert.equal((await ownerAOutcome).message, "MIAOBI_OWNERSHIP_LOST");
    const latePending = await pendingRecords(root);
    assert.equal(latePending.length, 1);
    assert.ok(latePending[0].generation < (await authoritativeState(root)).generation);
    const authority = await authoritativeState(root);
    assert.deepEqual(authority.deployment, ownerBState);
    assert.equal(ownerBState.releaseId, "59a06b5c2c12-20260913164700");

    const recoveryEvents: string[] = [];
    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner(recoveryEvents, "api"),
        gitCommit: COMMIT,
        now: new Date("2026-09-13T16:48:00.000Z"),
        lockClock: clock,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_CLI_FAILED",
    );
    assert.deepEqual(recoveryEvents, ["api"]);
  });
});

test("multiple unresolved generation transactions require recovery before any page action", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for recovery");
      },
    }));
    const first = await onlyPendingRecord(root);
    const secondToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const second = structuredClone(first);
    second.generation = first.generation + 1;
    second.ownerToken = secondToken;
    await writeFile(
      join(root, ".miaobi-recovery/pending", `${second.generation}-${secondToken}.json`),
      JSON.stringify(second),
      { mode: 0o600 },
    );

    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_PENDING_RECOVERY_REQUIRED",
    );
    assert.equal(calls, 0);
    assert.equal((await pendingRecords(root)).length, 2);
  });
});

test("a successor commits an older confirmed page without any new publication", { concurrency: false, timeout: 10_000 }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    let resumeOwnerA!: () => void;
    const ownerAGate = new Promise<void>((resolve) => { resumeOwnerA = resolve; });
    let ownerAReached!: () => void;
    const ownerAAtState = new Promise<void>((resolve) => { ownerAReached = resolve; });
    let ownerAIdentity: { generation: number; ownerToken: string } | undefined;
    const ownerA = deployMiaobi({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
      fetch: async (input) => healthyResponse(input),
      transactionHook: async (event) => {
        if (event.point !== "before-state-commit") return;
        ownerAIdentity = { generation: event.generation, ownerToken: event.ownerToken };
        ownerAReached();
        await ownerAGate;
      },
    });
    const ownerAOutcome = ownerA.catch((error: unknown) => error as Error);
    await ownerAAtState;
    assert.ok(ownerAIdentity);

    clock.stop();
    clock.current += LOCK_LEASE_MS + 10_000;
    const ownerBCalls: string[][] = [];
    const ownerBState = await deployMiaobi({
      runner: {
        async run(args) {
          ownerBCalls.push(args);
          throw new Error("confirmed recovery must not publish");
        },
      },
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      lockClock: clock,
    });
    resumeOwnerA();

    assert.equal((await ownerAOutcome).message, "MIAOBI_OWNERSHIP_LOST");
    assert.equal(ownerBCalls.length, 0);
    const stateFiles = await generationFiles(root, ".miaobi/states");
    assert.equal(stateFiles.length, 1);
    const authority = await authoritativeState(root);
    assert.deepEqual(authority.deployment, ownerBState);
    assert.equal(authority.resolvedGeneration, ownerAIdentity.generation);
    assert.equal(authority.resolvedOwnerToken, ownerAIdentity.ownerToken);
    assert.equal((await pendingRecords(root)).length, 1);
  });
});

test("a stale owner paused before cleanup cannot delete a successor pending or outrank its state", { concurrency: false, timeout: 10_000 }, async () => {
  await inFixture(async (root) => {
    const clock = new FakeLockClock();
    let resumeOwnerA!: () => void;
    const ownerAGate = new Promise<void>((resolve) => { resumeOwnerA = resolve; });
    let ownerAReached!: () => void;
    const ownerAAtCleanup = new Promise<void>((resolve) => { ownerAReached = resolve; });
    let ownerAIdentity: { generation: number; ownerToken: string } | undefined;
    type GenerationDeployOptions = Parameters<typeof deployMiaobi>[0] & {
      transactionHook?: (event: {
        point: "before-pending-commit" | "before-page-inflight" | "before-page-confirmation" | "before-state-commit" | "after-state-write" | "before-pending-cleanup";
        generation: number;
        ownerToken: string;
      }) => Promise<void>;
    };
    const deployWithGeneration = deployMiaobi as (options: GenerationDeployOptions) => Promise<MiaobiDeploymentState>;

    const ownerA = deployWithGeneration({
      runner: fakeRunner([]),
      gitCommit: COMMIT,
      now: NOW,
      lockClock: clock,
      fetch: async (input) => healthyResponse(input),
      transactionHook: async (event) => {
        if (event.point === "before-pending-cleanup") {
          ownerAIdentity = { generation: event.generation, ownerToken: event.ownerToken };
          ownerAReached();
          await ownerAGate;
        }
      },
    });
    const ownerAOutcome = ownerA.catch((error: unknown) => error as Error);
    await ownerAAtCleanup;
    assert.ok(ownerAIdentity, "deployment must expose the deterministic cleanup race point");

    clock.stop();
    clock.current += LOCK_LEASE_MS + 10_000;
    const ownerBEvents: string[] = [];
    let resolveOwnerBPage!: (result: { stdout: string; stderr: string }) => void;
    const ownerBPage = new Promise<{ stdout: string; stderr: string }>((resolve) => { resolveOwnerBPage = resolve; });
    let ownerBReachedPage!: () => void;
    const ownerBAtPage = new Promise<void>((resolve) => { ownerBReachedPage = resolve; });
    const ownerBBase = fakeRunner(ownerBEvents);
    const ownerB = deployWithGeneration({
      runner: {
        async run(args) {
          if (args[0] === "page") {
            ownerBEvents.push("page");
            ownerBReachedPage();
            return ownerBPage;
          }
          return ownerBBase.run(args);
        },
      },
      gitCommit: COMMIT,
      now: new Date("2026-09-13T16:47:00.000Z"),
      lockClock: clock,
      fetch: async (input) => healthyResponse(input, "api-new", "59a06b5c2c12-20260913164700"),
    });
    await ownerBAtPage;

    const pendingDirectory = join(root, ".miaobi-recovery/pending");
    const pendingBeforeResume = (await readdir(pendingDirectory)).sort();
    const ownerAName = `${ownerAIdentity.generation}-${ownerAIdentity.ownerToken}.json`;

    resumeOwnerA();
    const ownerAError = await ownerAOutcome;
    const pendingAfterOwnerA = (await readdir(pendingDirectory)).sort();

    resolveOwnerBPage({
      stdout: JSON.stringify({
        id: "vv6BtLE8MTR",
        html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR",
      }),
      stderr: "",
    });
    const ownerBState = await ownerB;
    assert.equal(pendingBeforeResume.length, 2);
    assert.equal(pendingBeforeResume.includes(ownerAName), true);
    assert.equal(pendingBeforeResume.some((name) => name !== ownerAName), true);
    assert.equal(ownerAError.message, "MIAOBI_OWNERSHIP_LOST");
    assert.deepEqual(pendingAfterOwnerA, pendingBeforeResume);
    const stateFiles = (await readdir(join(root, ".miaobi/states"))).filter((name) => name.endsWith(".json"));
    const generations = stateFiles.map((name) => Number(name.split("-", 1)[0]));
    assert.equal(Math.max(...generations) > ownerAIdentity.generation, true);
    const authoritativeName = stateFiles.sort((left, right) => Number(right.split("-", 1)[0]) - Number(left.split("-", 1)[0]))[0];
    const authoritative = JSON.parse(await readFile(join(root, ".miaobi/states", authoritativeName), "utf8"));
    assert.deepEqual(authoritative.deployment, ownerBState);
    assert.equal(ownerBState.releaseId, "59a06b5c2c12-20260913164700");
  });
});

test("different external and legacy pending records block every page action and remain intact", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for recovery");
      },
    }));
    const generated = await onlyPendingRecord(root);
    const generatedPath = join(root, ".miaobi-recovery/pending", `${generated.generation}-${generated.ownerToken}.json`);
    const externalPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const legacyPath = join(root, ".miaobi/deployment.pending.json");
    const external = structuredClone(generated.pending);
    await writeFile(externalPath, JSON.stringify(external), { mode: 0o600 });
    await rm(generatedPath);
    const legacy = structuredClone(external) as any;
    legacy.schemaVersion = 1;
    delete legacy.phase;
    delete legacy.apiBuildMarker;
    legacy.deployment.schemaVersion = 1;
    delete legacy.deployment.apiBuildMarker;
    delete legacy.deployment.assetProvider;
    delete legacy.deployment.pagesCommit;
    delete legacy.deployment.pagesBaseUrl;
    delete legacy.deployment.releaseManifestUrl;
    legacy.deployment.webFaasId = "web-other";
    legacy.deployment.webFaasUrl = "https://magic.solutionsuite.cn/api/faas/web-other";
    const otherPage = '<!doctype html><meta charset="utf-8"><script>location.replace("https://magic.solutionsuite.cn/api/faas/web-other")</script><a href="https://magic.solutionsuite.cn/api/faas/web-other">打开魔方简历</a>';
    legacy.page.sha256 = createHash("sha256").update(otherPage).digest("hex");
    await writeFile(legacyPath, JSON.stringify(legacy), { mode: 0o600 });
    const externalBefore = await readFile(externalPath, "utf8");
    const legacyBefore = await readFile(legacyPath, "utf8");

    let calls = 0;
    await assert.rejects(
      deployMiaobi({ runner: { async run() { calls += 1; throw new Error("must not run"); } }, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(calls, 0);
    assert.equal(await readFile(externalPath, "utf8"), externalBefore);
    assert.equal(await readFile(legacyPath, "utf8"), legacyBefore);
  });
});

test("mixed legacy and Pages anchors remain frozen when their page phase is unknowable", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: base,
      gitCommit: COMMIT,
      now: NOW,
      transactionHook: async ({ point }) => {
        if (point === "before-page-inflight") throw new Error("leave prepared for recovery");
      },
    }));
    const generated = await onlyPendingRecord(root);
    const generatedPath = join(root, ".miaobi-recovery/pending", `${generated.generation}-${generated.ownerToken}.json`);
    const externalPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const legacyPath = join(root, ".miaobi/deployment.pending.json");
    const external = structuredClone(generated.pending);
    await writeFile(externalPath, JSON.stringify(external), { mode: 0o600 });
    await rm(generatedPath);
    const legacy = structuredClone(external) as any;
    legacy.schemaVersion = 1;
    delete legacy.phase;
    delete legacy.apiBuildMarker;
    legacy.deployment.schemaVersion = 1;
    delete legacy.deployment.apiBuildMarker;
    delete legacy.deployment.assetProvider;
    delete legacy.deployment.pagesCommit;
    delete legacy.deployment.pagesBaseUrl;
    delete legacy.deployment.releaseManifestUrl;
    await writeFile(legacyPath, JSON.stringify(legacy), { mode: 0o600 });

    let calls = 0;
    await assert.rejects(
      deployMiaobi({
        runner: { async run() { calls += 1; throw new Error("must not publish"); } },
        gitCommit: COMMIT,
        now: NOW,
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.equal(calls, 0);
    assert.equal((await readFile(externalPath, "utf8")).length > 0, true);
    assert.equal((await readFile(legacyPath, "utf8")).length > 0, true);

    const nextEvents: string[] = [];
    await assert.rejects(
      deployMiaobi({
        runner: fakeRunner(nextEvents, "asset"),
        gitCommit: COMMIT,
        now: new Date("2026-09-13T16:47:00.000Z"),
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_PAGE_RESULT_UNCERTAIN",
    );
    assert.deepEqual(nextEvents, []);
  });
});
