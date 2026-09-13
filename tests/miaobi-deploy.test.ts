import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployMiaobi, type MiaobiDeploymentState } from "../scripts/miaobi/deploy";
import type { MagicBuilderRunner } from "../scripts/miaobi/types";

const COMMIT = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
const NOW = new Date("2026-09-13T16:46:00.000Z");
const RELEASE_ID = "59a06b5c2c12-20260913164600";

type Stage = "asset" | "api" | "web" | "page";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "magic-resume-deploy-"));
  await mkdir(join(root, "dist/miaobi/client/assets"), { recursive: true });
  await writeFile(join(root, "dist/miaobi/client/assets/app.js"), "console.log('app')");
  await writeFile(
    join(root, "dist/miaobi/client/index.html"),
    '<!doctype html><html><body><script type="module" src="https://miaobi.invalid/__ASSET_BASE__/app.js"></script></body></html>',
  );
  await writeFile(join(root, "dist/miaobi/api-faas.cjs"), "module.exports=()=>new Response()\n");
  return root;
}

function fakeRunner(events: string[], failAt?: Stage): MagicBuilderRunner {
  let upload = 0;
  return {
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
      const response = stage === "api"
        ? { id: "api-new", url: "https://api.example.test/faas/api-new" }
        : stage === "web"
          ? { id: "web-new", url: "https://web.example.test/faas/web-new" }
          : { id: "vv6BtLE8MTR", url: "https://page.example.test/vv6BtLE8MTR" };
      return { stdout: JSON.stringify(response), stderr: "" };
    },
  };
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

test("publishes assets, API, Web, checks both URLs, then switches the page and atomically saves state", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://api.example.test/")) {
        events.push("health-api");
        return Response.json({ error: "Not found", code: "notFound" }, { status: 404 });
      }
      events.push("health-web");
      return new Response('<!doctype html><script>window.__MAGIC_RESUME_RUNTIME__={}</script>');
    };

    const state = await deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW });
    assert.deepEqual(events, ["asset", "asset", "api", "web", "health-api", "health-web", "page"]);
    assert.deepEqual(state, {
      schemaVersion: 1,
      releaseId: RELEASE_ID,
      apiFaasId: "api-new",
      apiFaasUrl: "https://api.example.test/faas/api-new",
      webFaasId: "web-new",
      webFaasUrl: "https://web.example.test/faas/web-new",
      pageId: "vv6BtLE8MTR",
      deployedAt: NOW.toISOString(),
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, ".miaobi/deployment.json"), "utf8")), state);
    assert.equal((await readdir(join(root, ".miaobi"))).some((name) => name.startsWith("deployment.json.tmp-")), false);

    const page = await readFile(join(root, "dist/miaobi/page.html"), "utf8");
    assert.match(page, /^<!doctype html><meta charset="utf-8"><script>location\.replace\("https:\/\/web\.example\.test\/faas\/web-new"\)<\/script><a href="https:\/\/web\.example\.test\/faas\/web-new">/);
    assert.doesNotMatch(page, /workers\.dev|cloudflare/i);
  });
});

for (const failedStage of ["asset", "api", "web"] as const) {
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

test("a health failure neither switches the page nor leaks its response body", { concurrency: false }, async () => {
  await inFixture(async () => {
    const events: string[] = [];
    globalThis.fetch = async (input) => {
      events.push(String(input).includes("api.example") ? "health-api" : "health-web");
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

test("a state staging failure prevents the final page switch", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    globalThis.fetch = async (input) => {
      if (String(input).includes("api.example")) {
        events.push("health-api");
        return Response.json({ code: "notFound" }, { status: 404 });
      }
      events.push("health-web");
      await writeFile(join(root, ".miaobi"), "blocks-state-directory");
      return new Response("window.__MAGIC_RESUME_RUNTIME__");
    };

    await assert.rejects(
      deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_DEPLOY_FAILED",
    );
    assert.equal(events.includes("page"), false);
  });
});

test("a page update failure leaves the prior deployment state byte-for-byte intact", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const prior = '{"schemaVersion":1,"releaseId":"prior"}\n';
    await mkdir(join(root, ".miaobi"), { recursive: true });
    await writeFile(join(root, ".miaobi/deployment.json"), prior);
    globalThis.fetch = async (input) => String(input).includes("api.example")
      ? Response.json({ code: "notFound" }, { status: 404 })
      : new Response("window.__MAGIC_RESUME_RUNTIME__");

    await assert.rejects(
      deployMiaobi({ runner: fakeRunner([], "page"), gitCommit: COMMIT, now: NOW }),
    );
    assert.equal(await readFile(join(root, ".miaobi/deployment.json"), "utf8"), prior);
  });
});

test("a rerun updates existing FaaS resources with --id", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const prior: MiaobiDeploymentState = {
      schemaVersion: 1,
      releaseId: "prior-release",
      apiFaasId: "api-old",
      apiFaasUrl: "https://api.example.test/faas/api-old",
      webFaasId: "web-old",
      webFaasUrl: "https://web.example.test/faas/web-old",
      pageId: "vv6BtLE8MTR",
      deployedAt: "2026-09-12T00:00:00.000Z",
    };
    await mkdir(join(root, ".miaobi"), { recursive: true });
    await writeFile(join(root, ".miaobi/deployment.json"), JSON.stringify(prior));
    const calls: string[][] = [];
    const base = fakeRunner([]);
    const runner: MagicBuilderRunner = { async run(args) { calls.push(args); return base.run(args); } };
    globalThis.fetch = async (input) => String(input).includes("api.example")
      ? Response.json({ code: "notFound" }, { status: 404 })
      : new Response("window.__MAGIC_RESUME_RUNTIME__");

    await deployMiaobi({ runner, gitCommit: COMMIT, now: new Date("2026-09-13T16:47:00.000Z") });
    const faasCalls = calls.filter((args) => args[0] === "faas");
    assert.ok(faasCalls[0].includes("--id") && faasCalls[0].includes("api-old"));
    assert.ok(faasCalls[1].includes("--id") && faasCalls[1].includes("web-old"));
    const pageCall = calls.find((args) => args[0] === "page");
    assert.ok(pageCall?.includes("--id") && pageCall.includes("vv6BtLE8MTR"));
  });
});
