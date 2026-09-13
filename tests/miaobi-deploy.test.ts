import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deployMiaobi, type MiaobiDeploymentState } from "../scripts/miaobi/deploy";
import type { MagicBuilderRunner } from "../scripts/miaobi/types";

const COMMIT = "59a06b5c2c127d287d01016e5be4d781e310fe2e";
const BUILD_NONCE = "0123456789abcdef0123456789abcdef";
const BUILD_MARKER = `${COMMIT}.${BUILD_NONCE}`;
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
    assetBaseUrl: `https://tos.example.test/magic-resume/releases/${releaseId}/`,
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
    assert.deepEqual(events, ["asset", "asset", "api", "web", "health-api", "health-web", "page"]);
    assert.deepEqual(state, {
      schemaVersion: 2,
      apiBuildMarker: BUILD_MARKER,
      releaseId: RELEASE_ID,
      apiFaasId: "api-new",
      apiFaasUrl: "https://magic.solutionsuite.cn/api/faas/api-new",
      webFaasId: "web-new",
      webFaasUrl: "https://magic.solutionsuite.cn/api/faas/web-new",
      pageId: "vv6BtLE8MTR",
      deployedAt: NOW.toISOString(),
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, ".miaobi/deployment.json"), "utf8")), state);
    assert.equal((await readdir(join(root, ".miaobi"))).some((name) => name.startsWith("deployment.json.tmp-")), false);

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

test("health checks reject stale API/Web identity and runtime release markers", { concurrency: false }, async (context) => {
  const invalidWebBodies = [
    healthyResponse("https://magic.solutionsuite.cn/api/faas/web-new", "api-old").text(),
    healthyResponse("https://magic.solutionsuite.cn/api/faas/web-new", "api-new", "59a06b5c2c12-20260912000000").text(),
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

test("a state staging failure prevents the final page switch", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    globalThis.fetch = async (input) => {
      if (String(input).includes("/api/faas/api-new?")) {
        events.push("health-api");
        return healthyResponse(input);
      }
      events.push("health-web");
      await rename(join(root, ".miaobi"), join(root, ".miaobi-displaced"));
      await writeFile(join(root, ".miaobi"), "blocks-state-directory");
      return healthyResponse(input);
    };

    await assert.rejects(
      deployMiaobi({ runner: fakeRunner(events), gitCommit: COMMIT, now: NOW }),
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

test("creates trusted 0700 state storage and an exclusive 0600 staged state", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const base = fakeRunner(events);
    const runner: MagicBuilderRunner = {
      async run(args) {
        if (args[0] === "page") {
          const stateDirectory = join(root, ".miaobi");
          assert.equal((await stat(stateDirectory)).mode & 0o777, 0o700);
          const temporaryName = (await readdir(stateDirectory)).find((name) => name.startsWith("deployment.json.tmp-"));
          assert.ok(temporaryName);
          assert.equal((await stat(join(stateDirectory, temporaryName))).mode & 0o777, 0o600);
        }
        return base.run(args);
      },
    };
    globalThis.fetch = async (input) => healthyResponse(input);
    await deployMiaobi({ runner, gitCommit: COMMIT, now: NOW });
  });
});

test("detects a state-directory swap before rename and never commits attacker bytes", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const base = fakeRunner(events);
    const runner: MagicBuilderRunner = {
      async run(args) {
        if (args[0] === "page") {
          const stateDirectory = join(root, ".miaobi");
          const temporaryName = (await readdir(stateDirectory)).find((name) => name.startsWith("deployment.json.tmp-"));
          assert.ok(temporaryName);
          await rename(stateDirectory, join(root, ".miaobi-original"));
          await mkdir(stateDirectory, { mode: 0o700 });
          await writeFile(join(stateDirectory, temporaryName), "attacker-state", { mode: 0o600 });
        }
        return base.run(args);
      },
    };
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({ runner, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );
    await assert.rejects(readFile(join(root, ".miaobi/deployment.json"), "utf8"));
    const recovery = JSON.parse(await readFile(
      join(root, ".miaobi-recovery/deployment.pending.json"),
      "utf8",
    ));
    assert.equal(recovery.status, "pending-page-commit");
    assert.equal(recovery.page.id, "vv6BtLE8MTR");
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

test("a rerun updates existing FaaS resources with --id", { concurrency: false }, async () => {
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
    assert.ok(faasCalls[0].includes("--id") && faasCalls[0].includes("api-old"));
    assert.ok(faasCalls[0].includes("--name") && faasCalls[0].includes("magic-resume-api"));
    assert.ok(faasCalls[1].includes("--id") && faasCalls[1].includes("web-old"));
    assert.ok(faasCalls[1].includes("--name") && faasCalls[1].includes("magic-resume-web"));
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

test("keeps a durable pending page transaction when final state commit fails and reconciles it first", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const firstEvents: string[] = [];
    const base = fakeRunner(firstEvents);
    const firstRunner: MagicBuilderRunner = {
      async run(args) {
        const result = await base.run(args);
        if (args[0] === "page") {
          await mkdir(join(root, ".miaobi/deployment.json"));
        }
        return result;
      },
    };
    globalThis.fetch = async (input) => healthyResponse(input);

    await assert.rejects(
      deployMiaobi({ runner: firstRunner, gitCommit: COMMIT, now: NOW }),
      (error: unknown) => (error as Error).message === "MIAOBI_STATE_FAILED",
    );
    const pendingPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    assert.equal(pending.status, "pending-page-commit");
    assert.equal(pending.page.id, "vv6BtLE8MTR");
    assert.equal(pending.page.artifactPath, "dist/miaobi/page.html");
    assert.equal(pending.page.sha256, createHash("sha256")
      .update(await readFile(join(root, pending.page.artifactPath)))
      .digest("hex"));

    await rm(join(root, ".miaobi/deployment.json"), { recursive: true });
    const recoveryCalls: string[][] = [];
    const recoveryRunner: MagicBuilderRunner = {
      async run(args) {
        recoveryCalls.push(args);
        assert.equal(args[0], "page");
        return {
          stdout: JSON.stringify({
            id: "vv6BtLE8MTR",
            html_box_url: "https://magic.solutionsuite.cn/html-box/vv6BtLE8MTR",
          }),
          stderr: "",
        };
      },
    };
    const recovered = await deployMiaobi({ runner: recoveryRunner, gitCommit: COMMIT, now: NOW });
    assert.deepEqual(recovered, pending.deployment);
    assert.equal(recoveryCalls.length, 1);
    assert.ok(recoveryCalls[0].includes("--id") && recoveryCalls[0].includes("vv6BtLE8MTR"));
    await assert.rejects(readFile(pendingPath, "utf8"));
    assert.deepEqual(JSON.parse(await readFile(join(root, ".miaobi/deployment.json"), "utf8")), recovered);
  });
});

test("keeps pending on uncertain page output and ignores a mutable artifact during reconcile", { concurrency: false }, async () => {
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
    const pendingPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    await writeFile(join(root, pending.page.artifactPath), "tampered page");

    const publishedPages: string[] = [];
    const recovered = await deployMiaobi({
      runner: {
        async run(args) {
          assert.equal(args[0], "page");
          publishedPages.push(await readFile(args[2], "utf8"));
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
    assert.equal(recovered.webFaasId, "web-new");
    assert.match(publishedPages[0], /magic\.solutionsuite\.cn\/api\/faas\/web-new/);
    assert.doesNotMatch(publishedPages[0], /tampered/);
    await assert.rejects(readFile(pendingPath, "utf8"));
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

    const recoveryPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = JSON.parse(await readFile(recoveryPath, "utf8"));
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
    assert.equal(calls.length, 1);
    await assert.rejects(readFile(recoveryPath, "utf8"));
  });
});

test("rejects a pending artifact and matching attacker hash instead of switching it", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const events: string[] = [];
    const base = fakeRunner(events);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: {
        async run(args) {
          if (args[0] === "page") return { stdout: "uncertain", stderr: "" };
          return base.run(args);
        },
      },
      gitCommit: COMMIT,
      now: NOW,
    }));

    const recoveryPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = JSON.parse(await readFile(recoveryPath, "utf8"));
    const attackerPage = "<!doctype html><script>location='https://attacker.example'</script>";
    await writeFile(join(root, pending.page.artifactPath), attackerPage);
    pending.page.sha256 = createHash("sha256").update(attackerPage).digest("hex");
    await writeFile(recoveryPath, JSON.stringify(pending));

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

test("does not reclaim an old lock while its valid owner PID is alive", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await mkdir(join(root, ".miaobi-recovery"), { mode: 0o700 });
      const lockPath = join(root, ".miaobi-recovery/deployment.lock");
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await writeFile(lockPath, JSON.stringify({
        schemaVersion: 1,
        pid: child.pid,
        token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        startedAt: old.toISOString(),
        processStartedAt: new Date(old.getTime() - 1000).toISOString(),
      }), { mode: 0o600 });
      await utimes(lockPath, old, old);
      let calls = 0;
      await assert.rejects(
        deployMiaobi({ runner: { async run() { calls += 1; throw new Error(); } }, gitCommit: COMMIT, now: NOW }),
        (error: unknown) => (error as Error).message === "MIAOBI_STATE_LOCKED",
      );
      assert.equal(calls, 0);
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
    assert.equal(state.schemaVersion, 2);
  });
});

test("migrates a strictly validated version 1 deployment state and reuses its IDs", { concurrency: false }, async () => {
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
    assert.ok(faasCalls[0].includes("api-old"));
    assert.ok(faasCalls[1].includes("web-old"));
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.apiBuildMarker, BUILD_MARKER);
  });
});

test("reconciles a legacy pending only when local API metadata safely supplies its marker", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: { async run(args) { return args[0] === "page" ? { stdout: "uncertain", stderr: "" } : base.run(args); } },
      gitCommit: COMMIT,
      now: NOW,
    }));
    const currentPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const legacyPath = join(root, ".miaobi/deployment.pending.json");
    const legacy = JSON.parse(await readFile(currentPath, "utf8"));
    legacy.schemaVersion = 1;
    delete legacy.apiBuildMarker;
    legacy.deployment.schemaVersion = 1;
    delete legacy.deployment.apiBuildMarker;
    await writeFile(legacyPath, JSON.stringify(legacy), { mode: 0o600 });
    await rm(currentPath);

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
    assert.equal(recovered.schemaVersion, 2);
    assert.equal(recovered.apiBuildMarker, BUILD_MARKER);
    await assert.rejects(readFile(legacyPath, "utf8"));
  });
});

test("preserves a legacy pending whose marker disagrees with local API metadata", { concurrency: false }, async () => {
  await inFixture(async (root) => {
    const base = fakeRunner([]);
    globalThis.fetch = async (input) => healthyResponse(input);
    await assert.rejects(deployMiaobi({
      runner: { async run(args) { return args[0] === "page" ? { stdout: "uncertain", stderr: "" } : base.run(args); } },
      gitCommit: COMMIT,
      now: NOW,
    }));
    const pendingPath = join(root, ".miaobi-recovery/deployment.pending.json");
    const pending = JSON.parse(await readFile(pendingPath, "utf8"));
    const forgedMarker = `${COMMIT}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
    pending.schemaVersion = 1;
    pending.apiBuildMarker = forgedMarker;
    pending.deployment.schemaVersion = 1;
    pending.deployment.apiBuildMarker = forgedMarker;
    await writeFile(pendingPath, JSON.stringify(pending));

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
        runner: { async run(args) { return args[0] === "page" ? { stdout: "uncertain", stderr: "" } : base.run(args); } },
        gitCommit: COMMIT,
        now: NOW,
      }));
      const pendingPath = join(root, ".miaobi-recovery/deployment.pending.json");
      const pending = JSON.parse(await readFile(pendingPath, "utf8"));
      pending.deployment.releaseId = "aaaaaaaaaaaa-20260913164600";
      await writeFile(pendingPath, JSON.stringify(pending));
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
