import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  createJianguoyunProxyFetch,
  WebDavClient,
  type WebDavClientConfig,
} from "../src/lib/webdav/client";

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
    path: "magic-resume/",
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
    path: "magic-resume/",
    username: "account@example.test",
    password: "app-password",
    headers: { depth: "1", "content-type": "application/xml" },
    body: xml,
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
    path: "magic-resume/file.tmp",
    username: "account@example.test",
    password: "app-password",
    headers: {
      destination: "magic-resume/archive%20file.json",
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
