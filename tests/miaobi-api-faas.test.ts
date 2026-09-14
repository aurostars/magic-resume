import assert from "node:assert/strict";
import test from "node:test";
import { createMiaobiApiHandler, handleMiaobiApi } from "../miaobi/api-entry";
import { createMiaobiFaasAdapter } from "../scripts/miaobi/faas-adapter";

test("a POST FaaS request reaches the selected API route", async () => {
  const response = await handleMiaobiApi(
    new Request(
      "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar",
      { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
    ),
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("X-Magic-Resume-Faas"), "magic-resume-api");
  assert.deepEqual(await response.json(), {
    code: "invalidProvider",
    error: {
      code: "invalidProvider",
      message: "AI request failed (invalidProvider)",
    },
  });
});

test("the adapter removes only __path and preserves every other query value", async () => {
  let routedUrl = "";
  let routedLogicalPath = "";
  const adapter = createMiaobiFaasAdapter(async (request, logicalPath) => {
    routedUrl = request.url;
    routedLogicalPath = logicalPath;
    return Response.json({ routed: true });
  });
  const response = await adapter(
    new Request(
      "https://magic.solutionsuite.cn/api/faas/id?tenant=resume&__path=%2Fapi%2Fgrammar&tag=first&tag=second",
      { method: "POST" },
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(
    routedUrl,
    "https://magic.solutionsuite.cn/api/grammar?tenant=resume&tag=first&tag=second",
  );
  assert.equal(routedLogicalPath, "/api/grammar?tenant=resume&tag=first&tag=second");
});

for (const [name, url] of [
  ["missing", "https://magic.solutionsuite.cn/api/faas/id?tenant=resume"],
  [
    "duplicate",
    "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar&__path=%2Fapi%2Fpolish",
  ],
  [
    "nested duplicate",
    "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar%3F__path%3D%252Fapi%252Fpolish",
  ],
  ["absolute", "https://magic.solutionsuite.cn/api/faas/id?__path=https%3A%2F%2Fevil.test%2Fapi%2Fgrammar"],
  ["protocol-relative", "https://magic.solutionsuite.cn/api/faas/id?__path=%2F%2Fevil.test%2Fapi%2Fgrammar"],
  ["fragmented", "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fgrammar%23secret"],
] as const) {
  test(`${name} logical paths return the same safe 400 JSON`, async () => {
    const response = await handleMiaobiApi(new Request(url, { method: "POST" }));
    const text = await response.text();

    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(text), {
      error: "Invalid API path",
      code: "invalidPath",
    });
    assert.equal(text.includes("evil.test"), false);
    assert.equal(text.includes("secret"), false);
  });
}

test("the Miaobi image route uses its explicit pinned transport without ambient fetch", async () => {
  const ambientFetch = globalThis.fetch;
  let ambientCalls = 0;
  globalThis.fetch = async () => {
    ambientCalls += 1;
    throw new Error("ambient fetch must not be used");
  };

  try {
    const handler = createMiaobiApiHandler({
      fetch: async () => new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "image/png" },
      }),
    });
    const response = await handler(
      new Request(
        "https://magic.solutionsuite.cn/api/faas/id?__path=%2Fapi%2Fproxy%2Fimage&url=https%3A%2F%2Fimages.example.test%2Fphoto.png",
      ),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(1));
    assert.equal(ambientCalls, 0);
  } finally {
    globalThis.fetch = ambientFetch;
  }
});
