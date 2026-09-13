import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  handleImageProxy,
  MAX_IMAGE_RESPONSE_BYTES,
} from "../src/lib/server/image-proxy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function expectError(
  target: string | undefined,
  status: number,
  code: string,
) {
  const query = target === undefined ? "" : `?url=${encodeURIComponent(target)}`;
  const response = await handleImageProxy(
    new Request(`https://app.example/api/proxy/image${query}`),
  );
  const body = await response.json();
  assert.equal(response.status, status);
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  return JSON.stringify(body);
}

test("missing, malformed, and non-HTTP image URLs are rejected without a fetch", async () => {
  globalThis.fetch = (async () => {
    assert.fail("invalid targets must not be fetched");
  }) as typeof fetch;

  await expectError(undefined, 400, "invalidUrl");
  const malformed = await expectError("not a URL?secret=body", 400, "invalidUrl");
  const unsupported = await expectError("file:///etc/passwd", 400, "invalidUrl");

  assert.equal(malformed.includes("not a URL"), false);
  assert.equal(unsupported.includes("/etc/passwd"), false);
});

test("loopback, link-local, private IPv4, IPv6 loopback, and mapped private IPv6 are blocked", async () => {
  globalThis.fetch = (async () => {
    assert.fail("private targets must not be fetched");
  }) as typeof fetch;

  for (const target of [
    "http://localhost/private",
    "http://127.0.0.1/private",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/private",
    "http://172.16.0.1/private",
    "http://192.168.0.1/private",
    "http://[::1]/private",
    "http://[::ffff:10.0.0.1]/private",
  ]) {
    const text = await expectError(target, 403, "blockedTarget");
    assert.equal(text.includes(target), false);
  }
});

test("a public redirect to a private address is rejected before the second fetch", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response("redirect body must stay private", {
      status: 302,
      headers: { Location: "http://169.254.169.254/latest/meta-data?token=secret" },
    });
  }) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
  );
  const text = await response.text();

  assert.equal(response.status, 403);
  assert.deepEqual(JSON.parse(text), {
    error: "Image target is not allowed",
    code: "blockedTarget",
  });
  assert.deepEqual(requested, ["https://images.example.test/avatar.png"]);
  assert.equal(text.includes("169.254.169.254"), false);
  assert.equal(text.includes("redirect body"), false);
});

test("a successful image keeps the proxy response and request header contract", async () => {
  const bytes = Uint8Array.of(137, 80, 78, 71);
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Referer"), "https://images.example.test");
    assert.match(headers.get("User-Agent") ?? "", /Mozilla\/5\.0/);
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Cache-Control"), "no-store, no-cache, must-revalidate, proxy-revalidate");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("a successful non-image response is rejected without exposing its body", async () => {
  const privateBody = "private upstream document";
  globalThis.fetch = (async () =>
    new Response(privateBody, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar",
    ),
  );
  const text = await response.text();

  assert.equal(response.status, 415);
  assert.equal(JSON.parse(text).code, "invalidContentType");
  assert.equal(text.includes(privateBody), false);
});

test("an oversized chunked image is stopped while streaming", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_IMAGE_RESPONSE_BYTES));
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  globalThis.fetch = (async () =>
    new Response(stream, { headers: { "Content-Type": "image/png" } })) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Flarge.png",
    ),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "imageTooLarge");
  assert.equal(cancelled, true);
});

test("an aborted image request returns a safe timeout response", async () => {
  const controller = new AbortController();
  controller.abort();
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException(
      "https://images.example.test/private.png returned secret body",
      "AbortError",
    );
  }) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fprivate.png",
      { signal: controller.signal },
    ),
  );
  const text = await response.text();

  assert.equal(response.status, 504);
  assert.equal(JSON.parse(text).code, "timeout");
  assert.equal(text.includes("images.example.test"), false);
  assert.equal(text.includes("secret body"), false);
});

test("an abort while reading the image body is reported as a timeout", async () => {
  const controller = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      controller.abort();
      streamController.error(new DOMException("private body details", "AbortError"));
    },
  });
  globalThis.fetch = (async () =>
    new Response(stream, { headers: { "Content-Type": "image/png" } })) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fslow.png",
      { signal: controller.signal },
    ),
  );

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
});
