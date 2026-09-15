import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  createJianguoyunProxyFetch,
  isJianguoyunWebDavUrl,
  WebDavClient,
  type WebDavClientConfig,
} from "../src/lib/webdav/client";
import { handleJianguoyunWebDavProxy } from "../src/lib/server/jianguoyun-webdav-proxy";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

const config: WebDavClientConfig = {
  baseUrl: "https://dav.jianguoyun.com/dav",
  username: "account@example.test",
  password: "app-password",
  timeoutMs: 1_000,
};

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installMiaobiRuntime(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __MAGIC_RESUME_RUNTIME__: {
        platform: "miaobi",
        apiFunctionUrl: "https://magic.solutionsuite.cn/api/faas/test-id",
        assetBaseUrl: "https://aurostars.github.io/magic-resume/objects/test/",
      },
    },
  });
}

function recordingApiFetch(
  response: Response | ((call: RecordedCall) => Response) = new Response(null, { status: 204 }),
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return typeof response === "function" ? response(call) : response;
  };
  return { calls, fetchImpl };
}

async function payload(call: RecordedCall): Promise<Record<string, unknown>> {
  assert.equal(call.init.method, "POST");
  assert.equal(new Headers(call.init.headers).get("Content-Type"), "application/json");
  assert.equal(new Headers(call.init.headers).get("Cache-Control"), "no-store");
  assert.equal(typeof call.init.body, "string");
  return JSON.parse(call.init.body as string) as Record<string, unknown>;
}

beforeEach(installMiaobiRuntime);
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("Jianguoyun OPTIONS uses the same-origin API endpoint", async () => {
  const { calls, fetchImpl } = recordingApiFetch(new Response(null, {
    status: 204,
    headers: { DAV: "1", Allow: "OPTIONS, MOVE, DELETE" },
  }));
  globalThis.fetch = fetchImpl;

  const capabilities = await new WebDavClient(config).options("/magic-resume/");

  assert.deepEqual(capabilities, { conditionalMove: true });
  assert.equal(
    calls[0].url,
    "https://magic.solutionsuite.cn/api/faas/test-id?__path=%2Fapi%2Fwebdav%2Fjianguoyun",
  );
  assert.deepEqual(await payload(calls[0]), {
    method: "OPTIONS",
    pathSegments: ["magic-resume"],
    pathTrailingSlash: true,
    username: "account@example.test",
    password: "app-password",
  });
});

test("Jianguoyun PROPFIND forwards Depth and XML body through the envelope", async () => {
  const { calls, fetchImpl } = recordingApiFetch(new Response("<d:multistatus xmlns:d=\"DAV:\"/>", {
    status: 207,
  }));
  const proxyFetch = createJianguoyunProxyFetch(config, fetchImpl);
  const xml = "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:allprop/></d:propfind>";

  await proxyFetch("https://dav.jianguoyun.com/dav/magic-resume/", {
    method: "PROPFIND",
    headers: { Depth: "1", "Content-Type": "application/xml" },
    body: xml,
  });

  assert.deepEqual(await payload(calls[0]), {
    method: "PROPFIND",
    pathSegments: ["magic-resume"],
    pathTrailingSlash: true,
    username: "account@example.test",
    password: "app-password",
    headers: { depth: "1", "content-type": "application/xml" },
    bodyBase64: btoa(xml),
  });
});

test("Jianguoyun MOVE converts Destination to a relative Jianguoyun path", async () => {
  const { calls, fetchImpl } = recordingApiFetch(new Response(null, { status: 201 }));
  const proxyFetch = createJianguoyunProxyFetch(config, fetchImpl);

  await proxyFetch("https://dav.jianguoyun.com/dav/magic-resume/file.tmp", {
    method: "MOVE",
    headers: {
      Destination: "https://dav.jianguoyun.com/dav/magic-resume/archive%20file.json",
      Overwrite: "T",
    },
  });

  assert.deepEqual(await payload(calls[0]), {
    method: "MOVE",
    pathSegments: ["magic-resume", "file.tmp"],
    pathTrailingSlash: false,
    username: "account@example.test",
    password: "app-password",
    destinationSegments: ["magic-resume", "archive file.json"],
    destinationTrailingSlash: false,
    headers: {
      overwrite: "T",
    },
  });
});

test("Jianguoyun proxy responses preserve status ETag Last-Modified DAV Allow and body", async () => {
  const responseBody = "<d:multistatus xmlns:d=\"DAV:\"/>";
  const { fetchImpl } = recordingApiFetch(new Response(responseBody, {
    status: 207,
    headers: {
      ETag: '"revision-1"',
      "Last-Modified": "Tue, 15 Sep 2026 07:00:00 GMT",
      DAV: "1, 2",
      Allow: "OPTIONS, PROPFIND, MOVE",
    },
  }));

  const response = await createJianguoyunProxyFetch(config, fetchImpl)(
    "https://dav.jianguoyun.com/dav/magic-resume/",
    { method: "PROPFIND" },
  );

  assert.equal(response.status, 207);
  assert.equal(response.headers.get("ETag"), '"revision-1"');
  assert.equal(response.headers.get("Last-Modified"), "Tue, 15 Sep 2026 07:00:00 GMT");
  assert.equal(response.headers.get("DAV"), "1, 2");
  assert.equal(response.headers.get("Allow"), "OPTIONS, PROPFIND, MOVE");
  assert.equal(await response.text(), responseBody);
});

test("Jianguoyun credentials never appear in the request URL", async () => {
  const secretConfig = { ...config, username: "private-user", password: "private-password" };
  const { calls, fetchImpl } = recordingApiFetch();

  await createJianguoyunProxyFetch(secretConfig, fetchImpl)(
    "https://dav.jianguoyun.com/dav/magic-resume/manifest.json",
    { method: "GET" },
  );

  assert.equal(calls[0].url.includes("private-user"), false);
  assert.equal(calls[0].url.includes("private-password"), false);
});

test("non-Jianguoyun WebDAV keeps using the direct target URL", async () => {
  const { calls, fetchImpl } = recordingApiFetch();
  const client = new WebDavClient({ ...config, baseUrl: "https://dav.example.test/root" }, fetchImpl);

  await client.options("/magic-resume/");

  assert.equal(calls[0].url, "https://dav.example.test/root/magic-resume/");
  assert.equal(calls[0].init.method, "OPTIONS");
});

test("an explicitly injected transport keeps direct Jianguoyun requests", async () => {
  const { calls, fetchImpl } = recordingApiFetch();
  const client = new WebDavClient(config, fetchImpl);

  await client.options("/magic-resume/");

  assert.equal(calls[0].url, "https://dav.jianguoyun.com/dav/magic-resume/");
  assert.equal(calls[0].init.method, "OPTIONS");
});

test("a trailing-dot or lookalike Jianguoyun hostname does not select the proxy", async () => {
  for (const baseUrl of [
    "https://dav.jianguoyun.com./dav/",
    "https://dav.jianguoyun.com.example.test/dav/",
  ]) {
    const { calls, fetchImpl } = recordingApiFetch();
    globalThis.fetch = fetchImpl;

    await new WebDavClient({ ...config, baseUrl }).options("/magic-resume/");

    assert.equal(calls[0].url.startsWith("https://magic.solutionsuite.cn/"), false);
    assert.equal(new URL(calls[0].url).hostname, new URL(baseUrl).hostname);
  }
});

test("client envelope and Task 1 handler preserve literal path semantics", async () => {
  const cases = [
    ["%2e%2e", "%252e%252e"],
    ["percent%name", "percent%25name"],
    ["literal%20name", "literal%2520name"],
    ["literal%2520name", "literal%252520name"],
    ["目录", "%E7%9B%AE%E5%BD%95"],
    ["literal%2Fslash", "literal%252Fslash"],
  ] as const;

  for (const [literalName, expectedUpstreamName] of cases) {
    let upstreamUrl = "";
    const apiFetch: typeof fetch = async (input, init) => {
      const apiRequest = new Request(String(input), init);
      return handleJianguoyunWebDavProxy(apiRequest, {
        fetchImpl: async (upstreamInput) => {
          upstreamUrl = String(upstreamInput);
          return new Response("content", { status: 200 });
        },
      });
    };
    globalThis.fetch = apiFetch;

    assert.equal(await new WebDavClient(config).getText(`/${literalName}`), "content");
    assert.equal(
      upstreamUrl,
      `https://dav.jianguoyun.com/dav/${expectedUpstreamName}`,
      literalName,
    );
  }
});

test("Jianguoyun proxy fetch applies merged Request method headers body and signal", async () => {
  const { calls, fetchImpl } = recordingApiFetch();
  const controller = new AbortController();
  const request = new Request("https://dav.jianguoyun.com/dav/magic-resume/item.json", {
    method: "PUT",
    headers: { "If-Match": '"revision-1"', "Content-Type": "application/json" },
    body: "request-body",
    signal: controller.signal,
  });

  await createJianguoyunProxyFetch(config, fetchImpl)(request);

  assert.deepEqual(await payload(calls[0]), {
    method: "PUT",
    pathSegments: ["magic-resume", "item.json"],
    pathTrailingSlash: false,
    username: "account@example.test",
    password: "app-password",
    headers: { "content-type": "application/json", "if-match": '"revision-1"' },
    bodyBase64: btoa("request-body"),
  });
  const forwardedSignal = calls[0].init.signal;
  assert.ok(forwardedSignal);
  assert.equal(forwardedSignal.aborted, false);
  controller.abort();
  assert.equal(forwardedSignal.aborted, true);
});

test("Jianguoyun URL detection and public proxy fetch reject HTTP", async () => {
  const httpUrl = new URL("http://dav.jianguoyun.com/dav/magic-resume/");
  assert.equal(isJianguoyunWebDavUrl(httpUrl), false);
  assert.equal(isJianguoyunWebDavUrl(new URL("https://dav.jianguoyun.com:8443/dav/")), false);

  const { calls, fetchImpl } = recordingApiFetch();
  await assert.rejects(
    createJianguoyunProxyFetch(config, fetchImpl)(httpUrl, { method: "GET" }),
    (error: unknown) => error instanceof Error && error.message === "UNKNOWN",
  );
  assert.equal(calls.length, 0);
});

test("default runtime automatically selects the Jianguoyun proxy endpoint", async () => {
  Reflect.deleteProperty(globalThis, "window");
  const { calls, fetchImpl } = recordingApiFetch(new Response(null, { status: 204 }));
  globalThis.fetch = fetchImpl;

  await new WebDavClient(config).options("/magic-resume/");

  assert.equal(calls[0].url, "/api/webdav/jianguoyun");
  assert.deepEqual((await payload(calls[0])).pathSegments, ["magic-resume"]);
});


test("client-to-handler bodyBase64 preserves Unicode bytes and omits absent bodies", async () => {
  const unicode = "<?xml version=\"1.0\"?><文档>简历🚀</文档>";
  let upstreamBody = "";
  const apiFetch: typeof fetch = async (input, init) => {
    const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal("body" in envelope, false);
    return handleJianguoyunWebDavProxy(new Request(String(input), init), {
      fetchImpl: async (_upstream, upstreamInit) => {
        upstreamBody = new TextDecoder().decode(upstreamInit?.body as Uint8Array);
        return new Response(null, { status: 204 });
      },
    });
  };
  const proxyFetch = createJianguoyunProxyFetch(config, apiFetch);
  await proxyFetch("https://dav.jianguoyun.com/dav/magic-resume/item.xml", {
    method: "PUT",
    headers: { "Content-Type": "application/xml" },
    body: unicode,
  });
  assert.equal(upstreamBody, unicode);

  const { calls, fetchImpl } = recordingApiFetch();
  await createJianguoyunProxyFetch(config, fetchImpl)(
    "https://dav.jianguoyun.com/dav/magic-resume/item.xml",
    { method: "GET" },
  );
  const withoutBody = await payload(calls[0]);
  assert.equal("bodyBase64" in withoutBody, false);
});
