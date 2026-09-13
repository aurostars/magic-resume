import assert from "node:assert/strict";
import test from "node:test";
import {
  handleApiRequest,
  type ApiRouterDependencies,
} from "../src/lib/server/api-router";

function dependencies(): ApiRouterDependencies {
  return {
    grammar: async () => Response.json({ handledBy: "grammar" }),
    polish: async () => Response.json({ handledBy: "polish" }),
    resumeImport: async () => Response.json({ handledBy: "resumeImport" }),
    imageProxy: async () => Response.json({ handledBy: "imageProxy" }),
  };
}

for (const [path, method, handledBy] of [
  ["/api/grammar", "POST", "grammar"],
  ["/api/polish", "POST", "polish"],
  ["/api/resume-import", "POST", "resumeImport"],
  ["/api/proxy/image", "GET", "imageProxy"],
] as const) {
  test(`${method} ${path} returns the selected handler response`, async () => {
    const request = new Request(`https://app.example${path}`, { method });

    const response = await handleApiRequest(request, path, dependencies());

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { handledBy });
  });
}

test("a logical image path keeps its nested query available to the image handler", async () => {
  const deps = dependencies();
  deps.imageProxy = async (request) =>
    Response.json({ target: new URL(request.url).searchParams.get("url") });
  const response = await handleApiRequest(
    new Request(
      "https://functions.example/shared?tenant=resume&__path=%2Fapi%2Fproxy%2Fimage%3Furl%3Dhttps%253A%252F%252Fimages.example%252Fphoto.png",
    ),
    "/api/proxy/image?url=https%3A%2F%2Fimages.example%2Fphoto.png",
    deps,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    target: "https://images.example/photo.png",
  });
});

test("a known path with an unsupported method returns its allowed method", async () => {
  const response = await handleApiRequest(
    new Request("https://app.example/api/grammar", { method: "GET" }),
    undefined,
    dependencies(),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("Allow"), "POST");
  assert.deepEqual(await response.json(), {
    error: "Method not allowed",
    code: "methodNotAllowed",
  });
});

test("an unknown path returns a stable safe JSON error", async () => {
  const response = await handleApiRequest(
    new Request("https://app.example/api/not-a-route", { method: "POST" }),
    undefined,
    dependencies(),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: "Not found",
    code: "notFound",
  });
});

test("a handler failure returns a stable error without serializing the exception", async () => {
  const secret = "https://user:password@example.test/private?token=secret";
  const deps = dependencies();
  deps.grammar = async () => {
    throw new Error(secret);
  };

  const response = await handleApiRequest(
    new Request("https://app.example/api/grammar", { method: "POST" }),
    undefined,
    deps,
  );
  const text = await response.text();

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(text), {
    error: "Internal server error",
    code: "internalError",
  });
  assert.equal(text.includes(secret), false);
});
