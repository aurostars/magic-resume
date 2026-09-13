import assert from "node:assert/strict";
import test from "node:test";
import { WebDavClient } from "../src/lib/webdav/client";
import { WebDavError } from "../src/lib/webdav/errors";

type FetchCall = { url: string; init: RequestInit };

function recordingFetch(
  response: (call: FetchCall, index: number) => Response = () =>
    new Response(null, { status: 204 }),
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return response(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function clientWith(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof WebDavClient>[0]> = {}) {
  return new WebDavClient(
    {
      baseUrl: "https://dav.example.test/root?token=secret#fragment",
      username: "üser",
      password: "päss",
      timeoutMs: 1_000,
      ...overrides,
    },
    fetchImpl,
  );
}

async function expectWebDavError(
  operation: Promise<unknown> | (() => unknown),
  code: WebDavError["code"],
  status: number | null,
): Promise<WebDavError> {
  const promise = typeof operation === "function"
    ? Promise.resolve().then(operation)
    : operation;
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WebDavError);
  assert.equal(caught.code, code);
  assert.equal(caught.status, status);
  assert.equal(caught.message, code);
  return caught;
}

test("rejects insecure remote HTTP URLs but permits localhost loopback URLs", async () => {
  const { fetchImpl } = recordingFetch();

  await expectWebDavError(
    () => clientWith(fetchImpl, { baseUrl: "http://dav.example.test/root" }),
    "HTTPS_REQUIRED",
    null,
  );
  await clientWith(fetchImpl, { baseUrl: "http://localhost:8080/root" }).options("/");
  await clientWith(fetchImpl, { baseUrl: "http://127.0.0.1:8080/root" }).options("/");
});

test("OPTIONS strips base query and hash, encodes each path segment, and uses UTF-8 Basic auth", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl);

  await client.options("/目录/a b/%value/");

  assert.equal(calls[0].url, "https://dav.example.test/root/%E7%9B%AE%E5%BD%95/a%20b/%25value/");
  assert.equal(calls[0].init.method, "OPTIONS");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("Authorization"), "Basic w7xzZXI6cMOkc3M=");
  assert.equal(calls[0].url.includes("token=secret"), false);
  assert.equal(calls[0].url.includes("fragment"), false);
});

test("PROPFIND sends Depth zero and reports whether the resource exists", async () => {
  const { calls, fetchImpl } = recordingFetch((_call, index) =>
    new Response(null, { status: index === 0 ? 207 : 404 }),
  );
  const client = clientWith(fetchImpl);

  assert.equal(await client.propfind("/magic-resume/"), true);
  assert.equal(await client.propfind("/missing/"), false);

  assert.equal(calls[0].init.method, "PROPFIND");
  assert.equal(new Headers(calls[0].init.headers).get("Depth"), "0");
});

test("ensureDirectory creates every directory segment and accepts existing collections", async () => {
  const { calls, fetchImpl } = recordingFetch((_call, index) =>
    new Response(null, { status: index === 0 ? 201 : 405 }),
  );
  const client = clientWith(fetchImpl);

  await client.ensureDirectory("/magic resume/备份/");

  assert.deepEqual(
    calls.map(({ url, init }) => [init.method, url]),
    [
      ["MKCOL", "https://dav.example.test/root/magic%20resume/"],
      ["MKCOL", "https://dav.example.test/root/magic%20resume/%E5%A4%87%E4%BB%BD/"],
    ],
  );
});

test("GET returns text on success and null for a missing resource", async () => {
  const { calls, fetchImpl } = recordingFetch((_call, index) =>
    index === 0
      ? new Response("cloud text", { status: 200 })
      : new Response("not exposed", { status: 404 }),
  );
  const client = clientWith(fetchImpl);

  assert.equal(await client.getText("/cloud.json"), "cloud text");
  assert.equal(await client.getText("/missing.json"), null);
  assert.deepEqual(calls.map(({ init }) => init.method), ["GET", "GET"]);
});

test("GET returns the response ETag as the remote CAS token", async () => {
  const { fetchImpl } = recordingFetch(() =>
    new Response("cloud text", { status: 200, headers: { ETag: '"revision-1"' } }),
  );

  assert.deepEqual(await clientWith(fetchImpl).getTextWithMetadata("/cloud.json"), {
    text: "cloud text",
    etag: '"revision-1"',
  });
});

test("PUT sends atomic match and missing preconditions", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl);
  const content = '{"resume":"private résumé"}';

  await client.putText("/existing.json", content, { kind: "match", etag: '"r1"' });
  await client.putText("/new.json", content, { kind: "missing" });

  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.body, content);
  assert.equal(new Headers(calls[0].init.headers).get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(new Headers(calls[0].init.headers).get("If-Match"), '"r1"');
  assert.equal(new Headers(calls[1].init.headers).get("If-None-Match"), "*");
});

test("MOVE sends an absolute destination and Overwrite T without forwarding URL secrets", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl);

  await client.move("/magic-resume/file.tmp", "/magic-resume/magic resume.json");

  const headers = new Headers(calls[0].init.headers);
  assert.equal(calls[0].init.method, "MOVE");
  assert.equal(headers.get("Overwrite"), "T");
  assert.equal(
    headers.get("Destination"),
    "https://dav.example.test/root/magic-resume/magic%20resume.json",
  );
  assert.equal(headers.get("Destination")?.includes("token=secret"), false);
});

test("MOVE sends a tagged destination ETag condition for atomic replacement", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl);

  await client.move("/file.tmp", "/file.json", { kind: "match", etag: '"r1"' });

  const headers = new Headers(calls[0].init.headers);
  assert.equal(
    headers.get("If"),
    '<https://dav.example.test/root/file.json> (["r1"])',
  );
  assert.equal(headers.get("Overwrite"), "T");
});

test("maps failed remote preconditions and locks to REMOTE_CAS_MISMATCH", async () => {
  for (const status of [412, 423]) {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status }));
    await expectWebDavError(
      clientWith(fetchImpl).putText("/file.json", "{}", { kind: "missing" }),
      "REMOTE_CAS_MISMATCH",
      status,
    );
  }
});

test("DELETE rejects non-success responses instead of globally hiding cleanup failures", async () => {
  for (const status of [409, 423]) {
    const { calls, fetchImpl } = recordingFetch(() =>
      new Response("private server response", { status }),
    );
    await assert.rejects(
      clientWith(fetchImpl).delete("/manifest.json"),
      (error: unknown) => error instanceof WebDavError && error.status === status,
    );
    assert.equal(calls[0].init.method, "DELETE");
  }
});

test("maps HTTP failures to safe typed errors", async () => {
  const cases = [
    [401, "AUTH"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [507, "QUOTA"],
    [500, "SERVER"],
    [503, "SERVER"],
    [418, "UNKNOWN"],
  ] as const;

  for (const [status, code] of cases) {
    const { fetchImpl } = recordingFetch(() =>
      new Response("server response must stay private", { status }),
    );
    await expectWebDavError(clientWith(fetchImpl).options("/private?resume=secret"), code, status);
  }
});

test("maps unexpected MKCOL failures to DIRECTORY", async () => {
  const { fetchImpl } = recordingFetch(() => new Response(null, { status: 409 }));
  await expectWebDavError(clientWith(fetchImpl).ensureDirectory("/a/b/"), "DIRECTORY", 409);
});

test("classifies MOVE 405 and 501 as unsupported capability errors", async () => {
  for (const status of [405, 501]) {
    const { fetchImpl } = recordingFetch(() => new Response(null, { status }));
    await expectWebDavError(
      clientWith(fetchImpl).move("/from", "/to"),
      "MOVE_UNSUPPORTED",
      status,
    );
  }
});

test("normalizes fetch rejection without leaking credentials, query, body, or response content", async () => {
  const secretValues = ["päss", "token=secret", "private résumé", "Authorization", "server-body"];
  const fetchImpl: typeof fetch = async () => {
    throw new Error("network library failed: server-body");
  };
  const client = clientWith(fetchImpl);

  const error = await expectWebDavError(
    client.putText("/private?resume=secret", '{"resume":"private résumé"}'),
    "NETWORK",
    null,
  );
  const exposed = `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
  for (const secret of secretValues) assert.equal(exposed.includes(secret), false);
});

test("classifies timeout aborts and passes the linked signal to fetch", async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    observed.signal = init.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      observed.signal?.addEventListener("abort", () => reject(observed.signal?.reason), { once: true });
    });
  };
  const client = clientWith(fetchImpl, { timeoutMs: 10 });

  await expectWebDavError(client.options("/slow"), "TIMEOUT", null);
  assert.equal(observed.signal?.aborted, true);
});

test("classifies caller aborts and propagates them through the linked request signal", async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    observed.signal = init.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      observed.signal?.addEventListener("abort", () => reject(observed.signal?.reason), { once: true });
    });
  };
  const caller = new AbortController();
  const pending = clientWith(fetchImpl).getText("/cloud.json", caller.signal);
  caller.abort();

  await expectWebDavError(pending, "ABORTED", null);
  assert.equal(observed.signal?.aborted, true);
});

test("clears the timeout after a completed request", async () => {
  const observed: { signal: AbortSignal | null } = { signal: null };
  const { fetchImpl } = recordingFetch((call) => {
    observed.signal = call.init.signal ?? null;
    return new Response(null, { status: 204 });
  });
  const client = clientWith(fetchImpl, { timeoutMs: 10 });

  await client.options("/fast");
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(observed.signal?.aborted, false);
});

test("GET keeps timeout active while consuming the response body", async () => {
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    const signal = init.signal;
    const response = new Response(null, { status: 200 });
    response.text = async () =>
      await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("body timeout detail must stay private")),
          { once: true },
        );
        setTimeout(() => reject(new Error("body remained unbounded")), 60);
      });
    return response;
  };

  await expectWebDavError(
    clientWith(fetchImpl, { timeoutMs: 10 }).getText("/slow-body.json"),
    "TIMEOUT",
    null,
  );
});

test("GET keeps caller abort linked after headers arrive while consuming the body", async () => {
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const fetchImpl: typeof fetch = async (_input, init = {}) => {
    const signal = init.signal;
    const response = new Response(null, { status: 200 });
    response.text = async () =>
      await new Promise<string>((_resolve, reject) => {
        bodyStarted();
        signal?.addEventListener(
          "abort",
          () => reject(new Error("caller abort detail must stay private")),
          { once: true },
        );
        setTimeout(() => reject(new Error("caller abort was not linked")), 60);
      });
    return response;
  };
  const caller = new AbortController();
  const pending = clientWith(fetchImpl).getText("/body.json", caller.signal);
  await started;

  caller.abort(new Error("private caller reason"));

  await expectWebDavError(pending, "ABORTED", null);
});

test("GET normalizes body read rejection without leaking its details", async () => {
  const fetchImpl: typeof fetch = async () => {
    const response = new Response(null, { status: 200 });
    response.text = async () => {
      throw new Error("private body failure with résumé content");
    };
    return response;
  };

  const error = await expectWebDavError(
    clientWith(fetchImpl).getText("/private.json"),
    "NETWORK",
    null,
  );
  const exposed = `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
  assert.equal(exposed.includes("private body failure"), false);
  assert.equal(exposed.includes("résumé content"), false);
});

test("rejects dot-segment paths before they can escape the configured base path", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl, { baseUrl: "https://dav.example.test/root/base/" });

  await expectWebDavError(client.options("/safe/../escape"), "UNKNOWN", null);
  await expectWebDavError(client.options("/safe/./file"), "UNKNOWN", null);
  await expectWebDavError(client.move("/safe/source", "/safe/../escape"), "UNKNOWN", null);

  assert.deepEqual(calls, []);
});

test("rejects raw and encoded dot segments at every client path boundary before requests", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = clientWith(fetchImpl, { baseUrl: "https://dav.example.test/root/base/" });
  const operations = [
    () => client.options("/safe/%2e%2e/escape"),
    () => client.propfind("/safe/%2E/file"),
    () => client.listCollection("/safe/%2e%2e/"),
    () => client.ensureDirectory("/safe/../escape/"),
    () => client.getText("/safe/%2E%2E/file"),
    () => client.putText("/safe/%2e/file", "{}"),
    () => client.move("/safe/../source", "/safe/destination"),
    () => client.move("/safe/source", "/safe/%2e%2e/destination"),
    () => client.delete("/safe/%2E/file"),
  ];

  for (const operation of operations) {
    await expectWebDavError(operation(), "UNKNOWN", null);
  }

  assert.deepEqual(calls, []);
});

test("rejects base URL userinfo without sending or exposing it", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const userinfo = "embedded-user:embedded-password";
  const error = await expectWebDavError(
    () =>
      clientWith(fetchImpl, {
        baseUrl: `https://${userinfo}@dav.example.test/root?token=secret`,
      }),
    "UNKNOWN",
    null,
  );

  const exposed = `${error.name} ${error.message} ${error.stack ?? ""} ${JSON.stringify(error)}`;
  assert.equal(exposed.includes("embedded-user"), false);
  assert.equal(exposed.includes("embedded-password"), false);
  assert.deepEqual(calls, []);
});

test("PROPFIND Depth one lists decoded direct child files with ETags", async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/root/magic-resume/resumes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/root/magic-resume/resumes/CV%20one.json</d:href><d:propstat><d:prop><d:getetag>&quot;r1&quot;</d:getetag><d:resourcetype/></d:prop></d:propstat></d:response>
      <d:response><d:href>https://dav.example.test/root/magic-resume/resumes/%E5%8F%A6%E4%B8%80%E4%BB%BD.json</d:href><d:propstat><d:prop><d:getetag>W/&quot;r2&quot;</d:getetag><d:resourcetype/></d:prop></d:propstat></d:response>
      <d:response><d:href>/root/magic-resume/resumes/folder/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
      <d:response><d:href>/root/magic-resume/resumes/nested/ignored.json</d:href><d:propstat><d:prop><d:getetag>&quot;nested&quot;</d:getetag><d:resourcetype/></d:prop></d:propstat></d:response>
    </d:multistatus>`;
  const { calls, fetchImpl } = recordingFetch(() => new Response(xml, {
    status: 207,
    headers: { "Content-Type": "application/xml" },
  }));

  const files = await clientWith(fetchImpl).listCollection("/magic-resume/resumes/");

  assert.deepEqual(files, [
    { path: "CV one.json", etag: '"r1"' },
    { path: "另一份.json", etag: 'W/"r2"' },
  ]);
  assert.equal(calls[0].init.method, "PROPFIND");
  assert.equal(new Headers(calls[0].init.headers).get("Depth"), "1");
});

test("PROPFIND structurally parses namespace variants, entities, and CDATA", async () => {
  const xml = `<?xml version="1.0"?>
    <multistatus xmlns="DAV:">
      <response>
        <href><![CDATA[/root/magic-resume/resumes/CV%20one.json]]></href>
        <propstat><prop><getetag>&quot;r&amp;1&quot;</getetag><resourcetype /></prop></propstat>
      </response>
      <x:response xmlns:x="DAV:">
        <x:href>/root/magic-resume/resumes/%E5%8F%A6&#x4E00;&#x4EFD;.json</x:href>
        <x:propstat><x:prop><x:getetag>W/&quot;r2&quot;</x:getetag><x:resourcetype /></x:prop></x:propstat>
      </x:response>
    </multistatus>`;
  const { fetchImpl } = recordingFetch(() => new Response(xml, { status: 207 }));

  assert.deepEqual(
    await clientWith(fetchImpl).listCollection("/magic-resume/resumes/"),
    [
      { path: "CV one.json", etag: '"r&1"' },
      { path: "另一份.json", etag: 'W/"r2"' },
    ],
  );
});

test("PROPFIND ignores nested decoy hrefs and rejects the direct malicious href", async () => {
  const xml = `<d:multistatus xmlns:d="DAV:" xmlns:x="urn:decoy">
    <d:response>
      <x:wrapper><d:href>/root/magic-resume/resumes/decoy.json</d:href></x:wrapper>
      <d:href>/root/private/secret.json</d:href>
      <d:propstat><d:prop><d:getetag>&quot;x&quot;</d:getetag></d:prop></d:propstat>
    </d:response>
  </d:multistatus>`;
  const { fetchImpl } = recordingFetch(() => new Response(xml, { status: 207 }));

  await expectWebDavError(
    clientWith(fetchImpl).listCollection("/magic-resume/resumes/"),
    "UNKNOWN",
    null,
  );
});

test("PROPFIND rejects a multistatus href outside the requested collection", async () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/root/magic-resume/resumes/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/root/private/secret.json</d:href><d:propstat><d:prop><d:getetag>&quot;secret&quot;</d:getetag></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const { fetchImpl } = recordingFetch(() => new Response(xml, { status: 207 }));

  await expectWebDavError(
    clientWith(fetchImpl).listCollection("/magic-resume/resumes/"),
    "UNKNOWN",
    null,
  );
});

test("PROPFIND rejects cross-origin absolute hrefs", async () => {
  const xml = `<d:multistatus xmlns:d="DAV:">
    <d:response><d:href>https://attacker.example/root/magic-resume/resumes/stolen.json</d:href><d:propstat><d:prop><d:getetag>&quot;x&quot;</d:getetag></d:prop></d:propstat></d:response>
  </d:multistatus>`;
  const { fetchImpl } = recordingFetch(() => new Response(xml, { status: 207 }));

  await expectWebDavError(
    clientWith(fetchImpl).listCollection("/magic-resume/resumes/"),
    "UNKNOWN",
    null,
  );
});

test("MOVE Destination never includes base URL query or configured credentials", async () => {
  const { calls, fetchImpl } = recordingFetch();

  await clientWith(fetchImpl).move("/from.tmp", "/to.json", { kind: "missing" });

  const destination = new Headers(calls[0].init.headers).get("Destination") ?? "";
  assert.equal(destination, "https://dav.example.test/root/to.json");
  assert.equal(destination.includes("token=secret"), false);
  assert.equal(destination.includes("%C3%BCser"), false);
  assert.equal(destination.includes("p%C3%A4ss"), false);
  assert.equal(destination.includes("@"), false);
});
