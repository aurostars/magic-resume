import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  deployMiaobi,
  type MiaobiDeploymentStateV3,
} from "../scripts/miaobi/deploy";
import type { GitHubPagesPublication } from "../scripts/miaobi/publish-github-pages";
import type { MagicBuilderRunner } from "../scripts/miaobi/types";

const COMMIT = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
const BUILD_MARKER = `${COMMIT}.0123456789abcdef0123456789abcdef`;
const RELEASE_ID = "59a06b5c2c12-20260914100000";
const NOW = new Date("2026-09-14T10:00:00.000Z");
const PAGES_BASE = "https://aurostars.github.io/magic-resume/";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miaobi-pages-production-"));
  await mkdir(join(root, "dist/miaobi/client/assets"), { recursive: true });
  const index = '<!doctype html><script type="module" src="https://miaobi.invalid/__ASSET_BASE__/assets/app.js"></script>';
  const app = "console.log('app')";
  await writeFile(join(root, "dist/miaobi/client/index.html"), index);
  await writeFile(join(root, "dist/miaobi/client/assets/app.js"), app);
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

function publication(): GitHubPagesPublication {
  const index = new TextEncoder().encode("index");
  return {
    pagesCommit: "a".repeat(40),
    pagesBaseUrl: PAGES_BASE,
    releaseManifestUrl: `${PAGES_BASE}releases/${COMMIT}/manifest.json`,
    manifest: {
      schemaVersion: 1,
      provider: "github-pages",
      sourceCommit: COMMIT,
      releaseId: RELEASE_ID,
      createdAt: NOW.toISOString(),
      baseUrl: PAGES_BASE,
      files: {
        "index.html": {
          relativePath: "index.html",
          contentHash: createHash("sha256").update(index).digest("hex"),
          contentType: "text/html; charset=utf-8",
          key: `objects/${createHash("sha256").update(index).digest("hex")}/index.html`,
          objectPath: `objects/${createHash("sha256").update(index).digest("hex")}/index.html`,
          size: index.byteLength,
          url: `${PAGES_BASE}objects/${createHash("sha256").update(index).digest("hex")}/index.html`,
        },
      },
    },
  };
}

function magicRunner(events: string[], failAt?: "api" | "web" | "page"): MagicBuilderRunner {
  let apiSequence = 0;
  let webSequence = 0;
  return {
    async run(args) {
      assert.notEqual(args[0], "file", "GitHub Pages deployment must never invoke magic-builder file upload");
      const stage = args[0] === "page" ? "page" : args.includes("magic-resume-api") ? "api" : "web";
      events.push(stage);
      if (stage === failAt) throw new Error(`failed-${stage}`);
      if (stage === "api") {
        apiSequence += 1;
        return { stdout: JSON.stringify({ id: `api-${apiSequence}`, faas_url: `https://magic.solutionsuite.cn/api/faas/api-${apiSequence}` }), stderr: "" };
      }
      if (stage === "web") {
        webSequence += 1;
        return { stdout: JSON.stringify({ id: `web-${webSequence}`, faas_url: `https://magic.solutionsuite.cn/api/faas/web-${webSequence}` }), stderr: "" };
      }
      return { stdout: JSON.stringify({ id: "vv6BtLE8MTR", html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR" }), stderr: "" };
    },
  };
}

async function inFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fixture();
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await run(root);
  } finally {
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  }
}

function healthyFaas(input: RequestInfo | URL): Response {
  const url = String(input);
  if (url.includes("?__path=")) {
    return Response.json({ code: "notFound" }, { status: 404, headers: {
      "X-Magic-Resume-Faas": "magic-resume-api",
      "X-Magic-Resume-Build": BUILD_MARKER,
    } });
  }
  const apiId = /api-(\d+)/.exec(url)?.[1] ?? "1";
  return new Response(`<script>window.__MAGIC_RESUME_RUNTIME__=${JSON.stringify({
    platform: "miaobi",
    apiFunctionUrl: `https://magic.solutionsuite.cn/api/faas/api-${apiId}`,
    assetBaseUrl: PAGES_BASE,
  })}</script>`, { headers: { "X-Magic-Resume-Faas": "magic-resume-web" } });
}

async function stateFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(join(root, ".miaobi/states"))).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

test("publishes and verifies GitHub Pages before creating fresh FaaS, switching the page, and committing schema v3", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const published = publication();
    const state = await deployMiaobi({
      runner: magicRunner(events),
      gitCommit: COMMIT,
      now: NOW,
      fetch: async (input) => { events.push(String(input).includes("?__path=") ? "health-api" : "health-web"); return healthyFaas(input); },
      publishPages: async () => { events.push("pages-push"); return published; },
      verifyPages: async ({ publication: value }) => { assert.equal(value, published); events.push("pages-health"); },
    });

    assert.deepEqual(events, ["pages-push", "pages-health", "api", "web", "health-api", "health-web", "page"]);
    const expected: MiaobiDeploymentStateV3 = {
      schemaVersion: 3,
      assetProvider: "github-pages",
      pagesCommit: "a".repeat(40),
      pagesBaseUrl: PAGES_BASE,
      releaseManifestUrl: `${PAGES_BASE}releases/${COMMIT}/manifest.json`,
      apiBuildMarker: BUILD_MARKER,
      releaseId: RELEASE_ID,
      apiFaasId: "api-1",
      apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-1",
      webFaasId: "web-1",
      webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-1",
      pageId: "vv6BtLE8MTR",
      deployedAt: NOW.toISOString(),
    };
    assert.deepEqual(state, expected);
    assert.equal((await stateFiles(root)).length, 1);
  });
});

test("a Pages push or health failure leaves page and deployment state untouched and never invokes Magic CLI", { concurrency: false }, async (context) => {
  for (const stage of ["pages-push", "pages-health"] as const) {
    await context.test(stage, { concurrency: false }, async () => {
      await inFixture(async (root) => {
        const events: string[] = [];
        await assert.rejects(deployMiaobi({
          runner: magicRunner(events),
          gitCommit: COMMIT,
          now: NOW,
          publishPages: async () => {
            events.push("pages-push");
            if (stage === "pages-push") throw new Error("push failed");
            return publication();
          },
          verifyPages: async () => { events.push("pages-health"); throw new Error("health failed"); },
        }));
        assert.deepEqual(events, stage === "pages-push" ? ["pages-push"] : ["pages-push", "pages-health"]);
        assert.deepEqual(await stateFiles(root), []);
        await assert.rejects(readFile(join(root, "dist/miaobi/page.html"), "utf8"));
      });
    });
  }
});

test("losing ownership during the Pages push retains the release and stops before Pages health or Magic CLI", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const lockPath = join(root, ".miaobi-recovery/deployment.lock");
    await assert.rejects(
      deployMiaobi({
        runner: magicRunner(events),
        gitCommit: COMMIT,
        now: NOW,
        publishPages: async () => {
          events.push("pages-push");
          await rm(lockPath);
          await writeFile(lockPath, JSON.stringify({ token: "b".repeat(32) }), { mode: 0o600 });
          return publication();
        },
        verifyPages: async () => { events.push("pages-health"); },
      }),
      (error: unknown) => (error as Error).message === "MIAOBI_OWNERSHIP_LOST",
    );
    assert.deepEqual(events, ["pages-push"]);
    assert.deepEqual(await stateFiles(root), []);
  });
});

test("a FaaS failure after Pages health leaves only the unreferenced immutable Pages release", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    await assert.rejects(deployMiaobi({
      runner: magicRunner(events, "api"),
      gitCommit: COMMIT,
      now: NOW,
      publishPages: async () => { events.push("pages-push"); return publication(); },
      verifyPages: async () => { events.push("pages-health"); },
    }));
    assert.deepEqual(events, ["pages-push", "pages-health", "api"]);
    assert.deepEqual(await stateFiles(root), []);
    await assert.rejects(readFile(join(root, "dist/miaobi/page.html"), "utf8"));
  });
});

test("a rerun reuses the identical Pages release while always creating new FaaS resources", { concurrency: false }, async () => {
  await inFixture(async () => {
    const releases: string[] = [];
    const faasIds: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let sequence = attempt * 2;
      const runner: MagicBuilderRunner = {
        async run(args) {
          assert.notEqual(args[0], "file");
          if (args[0] === "page") return { stdout: JSON.stringify({ id: "vv6BtLE8MTR", html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR" }), stderr: "" };
          sequence += 1;
          const kind = args.includes("magic-resume-api") ? "api" : "web";
          const id = `${kind}-${sequence}`;
          faasIds.push(id);
          return { stdout: JSON.stringify({ id, faas_url: `https://magic.solutionsuite.cn/api/faas/${id}` }), stderr: "" };
        },
      };
      const state = await deployMiaobi({
        runner,
        gitCommit: COMMIT,
        now: attempt === 0 ? NOW : new Date("2026-09-15T11:00:00.000Z"),
        fetch: async (input) => {
          const url = String(input);
          if (url.includes("?__path=")) return healthyFaas(input);
          const apiId = faasIds.filter((id) => id.startsWith("api-")).at(-1)!;
          return new Response(`<script>window.__MAGIC_RESUME_RUNTIME__=${JSON.stringify({ platform: "miaobi", apiFunctionUrl: `https://magic.solutionsuite.cn/api/faas/${apiId}`, assetBaseUrl: PAGES_BASE })}</script>`, { headers: { "X-Magic-Resume-Faas": "magic-resume-web" } });
        },
        publishPages: async ({ releaseId }) => { releases.push(releaseId); return publication(); },
        verifyPages: async () => undefined,
      });
      assert.equal(state.releaseId, RELEASE_ID);
    }
    assert.deepEqual(releases, [RELEASE_ID, "59a06b5c2c12-20260915110000"]);
    assert.deepEqual(faasIds, ["api-1", "web-2", "api-3", "web-4"]);
  });
});
