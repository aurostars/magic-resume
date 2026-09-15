import assert from "node:assert/strict";
import test from "node:test";
import { handleJianguoyunWebDavProxy } from "../src/lib/server/jianguoyun-webdav-proxy";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function proxyRequest(payload: Record<string, unknown>, headers?: HeadersInit): Request {
  return new Request("https://magic.solutionsuite.cn/api/webdav/jianguoyun", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

const validPayload = {
  method: "GET",
  path: "magic-resume/manifest.json",
  username: "account@example.test",
  password: "app-password",
};

test("the Jianguoyun proxy constructs only the fixed HTTPS upstream", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    method: "PROPFIND",
    path: "magic-resume/manifest.json",
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

test("the Jianguoyun proxy rejects absolute paths and encoded path traversal", async (t) => {
  for (const path of [
    "/magic-resume/manifest.json",
    "https://evil.test/stolen",
    "https%3A//evil.test/stolen",
    "magic-resume/%2e%2e/stolen",
    "magic-resume/%2Fetc",
    "magic-resume\\manifest.json",
    "magic-resume/%00manifest.json",
  ]) {
    await t.test(path, async () => {
      let fetched = false;
      const response = await handleJianguoyunWebDavProxy(proxyRequest({
        ...validPayload,
        path,
      }), { fetchImpl: async () => { fetched = true; return new Response(); } });
      assert.equal(response.status, 400);
      assert.equal(fetched, false);
    });
  }
});

test("the Jianguoyun proxy rejects credentials embedded in path data", async () => {
  for (const path of [
    "magic-resume/account@example.test/manifest.json",
    "magic-resume/app-password/manifest.json",
  ]) {
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      path,
    }), { fetchImpl: async () => { throw new Error("must not fetch"); } });
    assert.equal(response.status, 400);
  }
});

test("MOVE rewrites an allowed relative Destination to the fixed upstream", async () => {
  let destination: string | null = null;
  const response = await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    method: "MOVE",
    headers: { Destination: "magic-resume/archive.json", Overwrite: "T" },
  }), {
    fetchImpl: async (_input, init) => {
      destination = new Headers(init?.headers).get("Destination");
      return new Response(null, { status: 201 });
    },
  });

  assert.equal(response.status, 201);
  assert.equal(destination, "https://dav.jianguoyun.com/dav/magic-resume/archive.json");
});

test("MOVE rejects an absolute or cross-origin Destination", async () => {
  for (const destination of [
    "https://dav.jianguoyun.com/dav/magic-resume/archive.json",
    "https://evil.test/archive.json",
    "/dav/magic-resume/archive.json",
  ]) {
    let fetched = false;
    const response = await handleJianguoyunWebDavProxy(proxyRequest({
      ...validPayload,
      method: "MOVE",
      headers: { Destination: destination },
    }), { fetchImpl: async () => { fetched = true; return new Response(); } });
    assert.equal(response.status, 400);
    assert.equal(fetched, false);
  }
});

test("the proxy forwards only Depth Destination Overwrite If If-Match If-None-Match and Content-Type", async () => {
  let forwarded = new Headers();
  await handleJianguoyunWebDavProxy(proxyRequest({
    ...validPayload,
    method: "PUT",
    body: "content",
    headers: {
      Depth: "1", Destination: "magic-resume/archive.json", Overwrite: "F",
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
  assert.equal(forwarded.get("Destination"), "magic-resume/archive.json");
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
  const response = await handleJianguoyunWebDavProxy(proxyRequest(validPayload), {
    fetchImpl: async (_input, init) => {
      redirect = init?.redirect;
      return new Response("redirect target", { status: 302, headers: { Location: "https://evil.test" } });
    },
  });

  assert.equal(redirect, "manual");
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
