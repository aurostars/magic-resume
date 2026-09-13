import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  createPinnedAddressTransport,
  handleImageProxy,
  MAX_IMAGE_RESPONSE_BYTES,
  type ImageProxyDependencies,
  type ImageProxyTransport,
} from "../src/lib/server/image-proxy";
import { Route as CloudflareImageRoute } from "../src/routes/api/proxy/image";

const originalFetch = globalThis.fetch;
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setRuntimeUserAgent(userAgent: string) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { userAgent },
  });
}

const directTestTransport: ImageProxyTransport = {
  fetch: (target, init) => globalThis.fetch(target, init),
};

function proxy(request: Request, dependencies: Partial<ImageProxyDependencies> = {}) {
  return handleImageProxy(request, {
    transport: directTestTransport,
    ...dependencies,
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "navigator");
  }
});

async function expectError(
  target: string | undefined,
  status: number,
  code: string,
  dependencies?: Partial<ImageProxyDependencies>,
) {
  const query = target === undefined ? "" : `?url=${encodeURIComponent(target)}`;
  const response = await proxy(
    new Request(`https://app.example/api/proxy/image${query}`),
    dependencies,
  );
  const body = await response.json();
  assert.equal(response.status, status);
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  return JSON.stringify(body);
}

test("the generic handler fails closed for a hostname without a trusted transport", async () => {
  globalThis.fetch = (async () => {
    assert.fail("the generic handler must not use ambient fetch for hostnames");
  }) as typeof fetch;

  const response = await handleImageProxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "blockedTarget");
});

test("the pinned transport rejects a hostname when any resolved A or AAAA address is non-public", async () => {
  let connected = false;
  const transport = createPinnedAddressTransport({
    resolveAll: async () => ["93.184.216.34", "fd00::1234"],
    connectToValidatedAddresses: async () => {
      connected = true;
      return new Response(Uint8Array.of(1), {
        headers: { "Content-Type": "image/png" },
      });
    },
  });

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
    { transport },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "blockedTarget");
  assert.equal(connected, false);
});

test("the pinned transport gives the connector only the complete validated address set", async () => {
  const resolved = ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"];
  let connectedAddresses: readonly string[] | undefined;
  const transport = createPinnedAddressTransport({
    resolveAll: async (hostname) => {
      assert.equal(hostname, "images.example.test");
      return resolved;
    },
    connectToValidatedAddresses: async (target, addresses, init) => {
      assert.equal(target.hostname, "images.example.test");
      assert.equal(init.redirect, "manual");
      connectedAddresses = addresses;
      return new Response(Uint8Array.of(1), {
        headers: { "Content-Type": "image/png" },
      });
    },
  });

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
    { transport },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(connectedAddresses, resolved);
});

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

test("authenticated URLs and non-default HTTP or HTTPS ports are rejected", async () => {
  globalThis.fetch = (async () => {
    assert.fail("credentialed and non-default port targets must not be fetched");
  }) as typeof fetch;

  for (const target of [
    "https://user:password@images.example.test/avatar.png",
    "http://images.example.test:81/avatar.png",
    "https://images.example.test:444/avatar.png",
  ]) {
    await expectError(target, 403, "blockedTarget");
  }
});

test("omitted and explicit default ports remain allowed", async () => {
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    requested.push(String(input));
    return new Response(Uint8Array.of(1), {
      headers: { "Content-Type": "image/png" },
    });
  }) as typeof fetch;

  for (const target of [
    "http://images.example.test/avatar.png",
    "http://images.example.test:80/avatar.png",
    "https://images.example.test/avatar.png",
    "https://images.example.test:443/avatar.png",
  ]) {
    const response = await proxy(
      new Request(
        `https://app.example/api/proxy/image?url=${encodeURIComponent(target)}`,
      ),
    );
    assert.equal(response.status, 200);
  }
  assert.equal(requested.length, 4);
});

test("loopback, link-local, private IPv4, IPv6 loopback, ULA, link-local, and mapped IPv6 are blocked", async () => {
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
    "http://[fc00::1]/private",
    "http://[fd12:3456:789a::1]/private",
    "http://[fe80::1]/private",
    "http://[::ffff:10.0.0.1]/private",
    "http://[::ffff:169.254.169.254]/private",
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

  const response = await proxy(
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

  const response = await proxy(
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

  const response = await proxy(
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

  const response = await proxy(
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

  const response = await proxy(
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

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fslow.png",
      { signal: controller.signal },
    ),
  );

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
});

test("non-2xx and non-image responses cancel their unconsumed bodies", async () => {
  for (const upstream of [
    { status: 503, contentType: "image/png", expectedCode: "upstreamError" },
    { status: 200, contentType: "text/html", expectedCode: "invalidContentType" },
  ]) {
    let cancelled = false;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: upstream.status,
          headers: { "Content-Type": upstream.contentType },
        },
      )) as typeof fetch;

    const response = await proxy(
      new Request(
        "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
      ),
    );

    assert.equal((await response.json()).code, upstream.expectedCode);
    assert.equal(cancelled, true);
  }
});

test("redirect bodies are cancelled at every hop before the next target is fetched", async () => {
  const cancelled: string[] = [];
  const resolved: string[] = [];
  const requested: string[] = [];
  const transport = createPinnedAddressTransport({
    resolveAll: async (hostname) => {
      resolved.push(hostname);
      return ["93.184.216.34"];
    },
    connectToValidatedAddresses: async (target) => {
      requested.push(target.href);
      if (target.hostname === "third.example.test") {
        return new Response(Uint8Array.of(1), {
          headers: { "Content-Type": "image/png" },
        });
      }
      const next = target.hostname === "first.example.test"
        ? "https://second.example.test/two"
        : "https://third.example.test/three";
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1));
          },
          cancel() {
            cancelled.push(target.hostname);
          },
        }),
        { status: 302, headers: { Location: next } },
      );
    },
  });

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Ffirst.example.test%2Fone",
    ),
    { transport },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(requested, [
    "https://first.example.test/one",
    "https://second.example.test/two",
    "https://third.example.test/three",
  ]);
  assert.deepEqual(resolved, [
    "first.example.test",
    "second.example.test",
    "third.example.test",
  ]);
  assert.deepEqual(cancelled, ["first.example.test", "second.example.test"]);
});

test("a rejected redirect Location cancels its body and cancellation failure preserves the fixed error", async () => {
  let cancelAttempted = false;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancelAttempted = true;
          throw new Error("private cancellation details");
        },
      }),
      {
        status: 302,
        headers: { Location: "http://169.254.169.254/metadata" },
      },
    )) as typeof fetch;

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Favatar.png",
    ),
  );

  assert.equal(response.status, 403);
  assert.equal(cancelAttempted, true);
  assert.deepEqual(await response.json(), {
    error: "Image target is not allowed",
    code: "blockedTarget",
  });
});

test("an empty image cancels and releases its body reader while preserving the fixed response", async () => {
  let cancelled = false;
  let released = false;
  const responseWithEmptyBody = {
    ok: true,
    headers: new Headers({ "Content-Type": "image/png" }),
    body: {
      getReader: () => ({
        read: async () => ({ done: true as const, value: undefined }),
        cancel: async () => {
          cancelled = true;
          throw new Error("cancel failure must stay private");
        },
        releaseLock: () => {
          released = true;
        },
      }),
    },
  } as unknown as Response;
  const transport: ImageProxyTransport = {
    fetch: async () => responseWithEmptyBody,
  };

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fempty.png",
    ),
    { transport },
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "emptyImage");
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test("the injected 15 second timeout aborts while waiting for upstream headers", async () => {
  const timeout = new AbortController();
  const transport: ImageProxyTransport = {
    fetch: async (_target, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("private fetch details", "AbortError")),
          { once: true },
        );
      });
    },
  };

  const responsePromise = proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fslow.png",
    ),
    {
      transport,
      timeoutSignal: (milliseconds) => {
        assert.equal(milliseconds, 15_000);
        return timeout.signal;
      },
    },
  );
  timeout.abort(new DOMException("deadline", "TimeoutError"));
  const response = await responsePromise;

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
});

test("the injected 15 second timeout aborts while reading the upstream body", async () => {
  const timeout = new AbortController();
  const transport: ImageProxyTransport = {
    fetch: async (_target, init) => {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = () =>
              controller.error(new DOMException("private body details", "AbortError"));
            if (init.signal?.aborted) fail();
            else init.signal?.addEventListener("abort", fail, { once: true });
          },
        }),
        { headers: { "Content-Type": "image/png" } },
      );
    },
  };

  const responsePromise = proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fslow.png",
    ),
    {
      transport,
      timeoutSignal: (milliseconds) => {
        assert.equal(milliseconds, 15_000);
        return timeout.signal;
      },
    },
  );
  await Promise.resolve();
  timeout.abort(new DOMException("deadline", "TimeoutError"));
  const response = await responsePromise;

  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
});

test("the shared route fails closed in the Node/default runtime", async () => {
  setRuntimeUserAgent("Node.js/24");
  globalThis.fetch = (async () => {
    assert.fail("the shared route must not use ambient Node fetch");
  }) as typeof fetch;
  const handler = CloudflareImageRoute.options.server?.handlers.GET;
  assert.equal(typeof handler, "function");

  const response = await handler!({
    request: new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fnode.png",
    ),
  } as never);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "blockedTarget");
});

test("the shared route delegates only in a verified Cloudflare runtime", async () => {
  setRuntimeUserAgent("Cloudflare-Workers");
  const bytes = Uint8Array.of(137, 80, 78, 71);
  let requested = "";
  globalThis.fetch = (async (input, init) => {
    requested = String(input);
    assert.equal(init?.redirect, "manual");
    return new Response(bytes, { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  const handler = CloudflareImageRoute.options.server?.handlers.GET;
  assert.equal(typeof handler, "function");

  const response = await handler!({
    request: new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fcloudflare.png",
    ),
  } as never);

  assert.equal(response.status, 200);
  assert.equal(requested, "https://images.example.test/cloudflare.png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test("the pinned transport resolves and validates again on a same-host redirect", async () => {
  let resolutions = 0;
  let connections = 0;
  const transport = createPinnedAddressTransport({
    resolveAll: async () => {
      resolutions += 1;
      return resolutions === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
    },
    connectToValidatedAddresses: async () => {
      connections += 1;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://images.example.test/rebound.png" },
      });
    },
  });

  const response = await proxy(
    new Request(
      "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Foriginal.png",
    ),
    { transport },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "blockedTarget");
  assert.equal(resolutions, 2);
  assert.equal(connections, 1);
});

test("the pinned transport rejects IPv6 addresses that are not proven globally routable", async () => {
  for (const address of [
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:a00:1::1",
    "3fff::1",
    "5f00::1",
    "64:ff9b::a00:1",
    "64:ff9b:1::a00:1",
    "fec0::1",
  ]) {
    let connected = false;
    const transport = createPinnedAddressTransport({
      resolveAll: async () => [address],
      connectToValidatedAddresses: async () => {
        connected = true;
        return new Response(Uint8Array.of(1), {
          headers: { "Content-Type": "image/png" },
        });
      },
    });

    const response = await proxy(
      new Request(
        "https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fspecial.png",
      ),
      { transport },
    );

    assert.equal(response.status, 403, address);
    assert.equal((await response.json()).code, "blockedTarget", address);
    assert.equal(connected, false, address);
  }
});
