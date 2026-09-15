import assert from "node:assert/strict";
import test from "node:test";
import { handleJianguoyunWebDavProxy } from "../src/lib/server/jianguoyun-webdav-proxy";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

async function resolvesWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("operation did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function proxyRequest(payload: Record<string, unknown>, headers?: HeadersInit): Request {
  return new Request("https://magic.solutionsuite.cn/api/webdav/jianguoyun", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

const validPayload = {
  method: "GET",
  pathSegments: ["magic-resume", "manifest.json"],
  pathTrailingSlash: false,
  username: "account@example.test",
  password: "app-password",
};

test("the Jianguoyun proxy constructs only the fixed HTTPS upstream", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    method: "PROPFIND",
    pathSegments: ["magic-resume", "manifest.json"],
    pathTrailingSlash: false,
    username: "account@example.test",
    password: "app-password",
    headers: { Depth: "0" },
  }), {
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response("<multistatus/>", {
        status: 207,
        headers: { "Content-Type": "application/xml", ETag: '"v1"', Cookie: "secret" },
      });
    },
  });

  assert.equal(calls[0].url,
    "https://dav.jianguoyun.com/dav/magic-resume/manifest.json");
  assert.equal(calls[0].init?.method, "PROPFIND");
  assert.equal(new Headers(calls[0].init?.headers).get("Authorization"),
    `Basic ${btoa("account@example.test:app-password")}`);
  assert.equal(response.status, 207);
  assert.equal(response.headers.get("ETag"), '"v1"');
  assert.equal(response.headers.get("Cookie"), null);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("the Jianguoyun proxy rejects unsupported methods before fetch", async () => {
  let fetched = false;
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    method: "POST",
  }), { fetchImpl: async () => { fetched = true; return new Response(); } });

  assert.equal(response.status, 400);
  assert.equal(fetched, false);
});

test("the Jianguoyun proxy rejects invalid source path segments before fetch", async (t) => {
  const invalidSegments: Array<{ name: string; value: unknown }> = [
    { name: "non-array", value: "magic-resume/manifest.json" },
    { name: "non-string", value: ["magic-resume", 1] },
    { name: "empty-array", value: [] },
    { name: "empty", value: ["magic-resume", ""] },
    { name: "dot", value: ["magic-resume", "."] },
    { name: "dot-dot", value: ["magic-resume", ".."] },
    { name: "slash", value: ["magic-resume", "nested/file"] },
    { name: "backslash", value: ["magic-resume", "nested\\file"] },
    { name: "nul", value: ["magic-resume", "nul\0file"] },
    { name: "control", value: ["magic-resume", "line\nfile"] },
    { name: "too-many", value: Array.from({ length: 257 }, () => "segment") },
    { name: "too-long", value: ["x".repeat(1025)] },
  ];

  for (const { name, value } of invalidSegments) {
    await t.test(name, async () => {
      let fetched = false;
      const response = await handleJianguoyunWebDavProxy(proxyRequest({
        ...validPayload,
        pathSegments: value,
      }), { fetchImpl: async () => { fetched = true; return new Response(); } });
      assert.equal(response.status, 400);
      assert.equal(fetched, false);
    });
  }
});

test("the Jianguoyun proxy rejects credentials embedded in path data", async () => {
  for (const pathSegments of [
    ["magic-resume", "account@example.test", "manifest.json"],
    ["magic-resume", "app-password", "manifest.json"],
  ]) {
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      pathSegments,
    }), { fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400);
  }
});

test("MOVE rewrites an allowed relative Destination to the fixed upstream", async () => {
  let destination: string | null = null;
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    method: "MOVE",
    destinationSegments: ["magic-resume", "archive.json"],
    destinationTrailingSlash: false,
    headers: { Overwrite: "T" },
  }), {
    fetchImpl: async (_input, init) => {
      destination = new Headers(init?.headers).get("Destination");
      return new Response(null, { status: 201 });
    },
  });

  assert.equal(response.status, 201);
  assert.equal(destination, "https://dav.jianguoyun.com/dav/magic-resume/archive.json");
});

test("MOVE rejects invalid Destination segments before fetch", async () => {
  const invalidDestinations: unknown[] = [
    "magic-resume/archive.json",
    ["magic-resume", 1],
    [],
    ["magic-resume", ""],
    ["magic-resume", "."],
    ["magic-resume", ".."],
    ["magic-resume", "nested/file"],
    ["magic-resume", "nested\\file"],
    ["magic-resume", "nul\0file"],
    ["magic-resume", "line\nfile"],
    Array.from({ length: 257 }, () => "segment"),
    ["x".repeat(1025)],
  ];
  for (const destinationSegments of invalidDestinations) {
    let fetched = false;
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      method: "MOVE",
      destinationSegments,
      destinationTrailingSlash: false,
    }), { fetchImpl: async () => { fetched = true; return new Response(); } });
    assert.equal(response.status, 400);
    assert.equal(fetched, false);
  }
});

test("the proxy forwards only Depth Overwrite If If-Match If-None-Match and Content-Type", async () => {
  let forwarded = new Headers();
  await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    method: "PUT",
    body: "content",
    headers: {
      Depth: "1", Overwrite: "F",
      If: "(<token>)", "If-Match": '"v1"', "If-None-Match": "*",
      "Content-Type": "application/octet-stream", Cookie: "secret", Host: "evil.test",
      Authorization: "Bearer attacker",
    },
  }), {
    fetchImpl: async (_input, init) => {
      forwarded = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(forwarded.get("Depth"), "1");
  assert.equal(forwarded.get("Destination"), null);
  assert.equal(forwarded.get("Overwrite"), "F");
  assert.equal(forwarded.get("If"), "(<token>)");
  assert.equal(forwarded.get("If-Match"), '"v1"');
  assert.equal(forwarded.get("If-None-Match"), "*");
  assert.equal(forwarded.get("Content-Type"), "application/octet-stream");
  assert.equal(forwarded.get("Cookie"), null);
  assert.equal(forwarded.get("Host"), null);
  assert.equal(forwarded.get("Authorization"), `Basic ${btoa("account@example.test:app-password")}`);
});

test("the proxy disables redirects", async () => {
  let redirect: RequestRedirect | undefined;
  let canceled = false;
  const redirectBody = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("redirect target"));
    },
    cancel() {
      canceled = true;
      return Promise.reject(new Error("cancellation secret must be swallowed"));
    },
  });
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async (_input, init) => {
      redirect = init?.redirect;
      return new Response(redirectBody, { status: 302, headers: { Location: "https://evil.test" } });
    },
  });

  assert.equal(redirect, "manual");
  assert.equal(canceled, true);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
});

test("the proxy rejects request bodies over 8 MiB", async () => {
  let fetched = false;
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload, {
    "Content-Length": String(MAX_BODY_BYTES + 1),
  }), { fetchImpl: async () => { fetched = true; return new Response(); } });

  assert.equal(response.status, 413);
  assert.equal(fetched, false);
});

test("the proxy rejects response bodies over 8 MiB", async () => {
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async () => new Response(new Uint8Array(MAX_BODY_BYTES + 1)),
  });

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
});

test("the proxy timeout returns a stable sanitized JSON error", async () => {
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    timeoutMs: 1,
    fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timed out upstream secret")));
    }),
  });

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
});

test("proxy errors never include username password Authorization or upstream body", async () => {
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async () => {
      throw new Error("account@example.test app-password Authorization private upstream body");
    },
  });
  const text = await response.text();

  assert.equal(response.status, 502);
  for (const secret of ["account@example.test", "app-password", "Authorization", "upstream body"]) {
    assert.equal(text.includes(secret), false);
  }
  assert.deepEqual(JSON.parse(text), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
});

test("the proxy preserves multi-encoded percent text as a literal segment", async () => {
  const upstreamUrls: string[] = [];
  for (const [segment, expected] of [
    ["%252e%252e", "%25252e%25252e"],
    ["%25252525252525252541", "%2525252525252525252541"],
  ]) {
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      pathSegments: ["magic-resume", segment, "manifest.json"],
    }), {
      fetchImpl: async (input) => {
        upstreamUrls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(response.status, 204);
    assert.equal(
      upstreamUrls.at(-1),
      `https://dav.jianguoyun.com/dav/magic-resume/${expected}/manifest.json`,
    );
  }
});

test("the proxy preserves UTF-8 credentials in Basic authorization", async () => {
  let authorization: string | null = null;
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    username: "用户@example.test",
    password: "密碼",
  }), {
    fetchImpl: async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(response.status, 204);
  assert.equal(authorization, "Basic 55So5oi3QGV4YW1wbGUudGVzdDrlr4bnorw=");
});

test("the proxy rejects colon and control characters in usernames before fetch", async () => {
  for (const username of [
    "account:admin",
    "account\nadmin",
    "account\0admin",
    "account\u007fadmin",
    "account\u0085admin",
  ]) {
    let fetched = false;
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      username,
    }), { fetchImpl: async () => { fetched = true; return new Response(); } });
    assert.equal(response.status, 400);
    assert.equal(fetched, false);
  }
});

test("MOVE rejects credentials embedded in Destination segments", async () => {
  for (const destinationSegments of [
    ["magic-resume", "account@example.test", "archive.json"],
    ["magic-resume", "app-password", "archive.json"],
  ]) {
    let fetched = false;
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      method: "MOVE",
      destinationSegments,
      destinationTrailingSlash: false,
    }), { fetchImpl: async () => { fetched = true; return new Response(); } });
    assert.equal(response.status, 400);
    assert.equal(fetched, false);
  }
});

test("WebDAV business statuses preserve status and safe headers while discarding upstream bodies", async () => {
  for (const status of [401, 403, 404, 405, 409, 412, 423, 500, 503]) {
    let canceled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("upstream account@example.test app-password"));
      },
      cancel() {
        canceled = true;
      },
    });
    const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
      fetchImpl: async () => new Response(body, {
        status,
        headers: { ETag: '"safe"', Cookie: "secret" },
      }),
    });

    assert.equal(response.status, status);
    assert.equal(response.headers.get("ETag"), '"safe"');
    assert.equal(response.headers.get("Cookie"), null);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(await response.text(), "");
    assert.equal(canceled, true);
  }
});

test("invalid forwarded header values return only the stable sanitized proxy error", async () => {
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    headers: { If: "account@example.test\napp-password" },
  }), { fetchImpl: async () => { throw new Error("must not fetch"); } });
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(text), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
  assert.equal(text.includes("account@example.test"), false);
  assert.equal(text.includes("app-password"), false);
});

test("the proxy streams and cancels an oversized request body promptly", async () => {
  let canceled = false;
  let pulls = 0;
  const requestBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 3) controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      else controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://magic.solutionsuite.cn/api/webdav/jianguoyun", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await handleJianguoyunWebDavProxy(request, {
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });

  assert.equal(response.status, 413);
  assert.equal(canceled, true);
  assert.ok(pulls <= 3, `oversized request pulled ${pulls} chunks`);
});

test("the proxy streams and cancels an oversized response body promptly", async () => {
  let canceled = false;
  let pulls = 0;
  const upstreamBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls <= 3) controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      else controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async () => new Response(upstreamBody),
  });

  assert.equal(response.status, 502);
  assert.equal(canceled, true);
  assert.ok(pulls <= 3, `oversized response pulled ${pulls} chunks`);
});

test("a never-settling response body cancel cannot block a stable redirect error", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  const response = await resolvesWithin(handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async () => new Response(body, { status: 302 }),
  }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "Jianguoyun WebDAV proxy failed",
    code: "webdavProxyFailed",
  });
});

test("a never-settling request body cancel cannot block a declared size rejection", async () => {
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  const request = new Request("https://magic.solutionsuite.cn/api/webdav/jianguoyun", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(MAX_BODY_BYTES + 1),
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const response = await resolvesWithin(handleJianguoyunWebDavProxy(request));

  assert.equal(response.status, 413);
});

test("a never-settling reader cancel cannot block an oversized stream rejection", async () => {
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  const response = await resolvesWithin(handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async () => new Response(body),
  }));

  assert.equal(response.status, 502);
  assert.ok(pulls <= 3, `oversized response pulled ${pulls} chunks`);
});

test("logical source and Destination segments are encoded exactly once", async () => {
  const cases = [
    ["%2e%2e", "%252e%252e"],
    ["literal%20name", "literal%2520name"],
    ["literal%2520name", "literal%252520name"],
    ["目录", "%E7%9B%AE%E5%BD%95"],
    ["literal%2Fslash", "literal%252Fslash"],
  ] as const;

  for (const [segment, expected] of cases) {
    let source = "";
    let destination = "";
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      method: "MOVE",
      pathSegments: ["magic-resume", segment],
      destinationSegments: ["archive", segment],
      destinationTrailingSlash: false,
    }), {
      fetchImpl: async (input, init) => {
        source = String(input);
        destination = new Headers(init?.headers).get("Destination") ?? "";
        return new Response(null, { status: 201 });
      },
    });
    assert.equal(response.status, 201);
    assert.equal(source, `https://dav.jianguoyun.com/dav/magic-resume/${expected}`);
    assert.equal(destination, `https://dav.jianguoyun.com/dav/archive/${expected}`);
  }
});

test("the proxy rejects forged legacy pathEncoding envelopes", async () => {
  for (const pathEncoding of ["url-path", "decode-all"]) {
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      pathEncoding,
    }), { fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400);
  }
});

test("the proxy rejects ambiguous legacy path and Destination fields", async () => {
  for (const extra of [
    { path: "magic-resume/manifest.json" },
    { headers: { Destination: "magic-resume/archive.json" } },
    { pathTrailingSlash: "false" },
  ]) {
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      ...extra,
    }), { fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400);
  }
});
