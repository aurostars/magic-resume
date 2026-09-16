import assert from "node:assert/strict";
import test from "node:test";
import { testWebDavConnection } from "../src/lib/webdav/connection-test";
import { WebDavError } from "../src/lib/webdav/errors";

type FetchCall = { url: string; method: string; signal: AbortSignal | null };

const settings = {
  baseUrl: "https://webdav.example.test/dav",
  username: "user",
  password: "password",
  timeoutMs: 1_000,
  remoteDirectory: "/magic-resume/",
};

function recordingFetch(
  respond: (call: FetchCall, index: number) => Response | Promise<Response> = () =>
    new Response(null, { status: 204 }),
): { calls: FetchCall[]; fetchImpl: typeof fetch } {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const call = {
      url: String(input),
      method: init.method ?? "GET",
      signal: init.signal ?? null,
    };
    calls.push(call);
    return await respond(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

async function captureWebDavError(operation: Promise<unknown>): Promise<WebDavError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof WebDavError);
  return caught;
}

test("tests the configured directory with OPTIONS followed by PROPFIND", async () => {
  const { calls, fetchImpl } = recordingFetch();

  await testWebDavConnection(settings, undefined, fetchImpl);

  assert.deepEqual(calls.map((call) => call.method), ["OPTIONS", "PROPFIND"]);
  assert.equal(new URL(calls[0].url).pathname, "/dav/magic-resume/");
  assert.equal(new URL(calls[1].url).pathname, "/dav/magic-resume/");
});

test("stops after an OPTIONS failure and preserves its typed status", async () => {
  const { calls, fetchImpl } = recordingFetch(() => new Response(null, { status: 401 }));

  const error = await captureWebDavError(testWebDavConnection(settings, undefined, fetchImpl));

  assert.equal(error.code, "AUTH");
  assert.equal(error.status, 401);
  assert.deepEqual(calls.map((call) => call.method), ["OPTIONS"]);
});

test("propagates a PROPFIND failure", async () => {
  const { calls, fetchImpl } = recordingFetch((_call, index) =>
    new Response(null, { status: index === 0 ? 204 : 503 })
  );

  const error = await captureWebDavError(testWebDavConnection(settings, undefined, fetchImpl));

  assert.equal(error.code, "SERVER");
  assert.equal(error.status, 503);
  assert.deepEqual(calls.map((call) => call.method), ["OPTIONS", "PROPFIND"]);
});

test("links the same caller AbortSignal to both requests", async () => {
  const caller = new AbortController();
  const abortReason = new Error("caller stopped");
  caller.abort(abortReason);
  const observedSignals: AbortSignal[] = [];
  const { fetchImpl } = recordingFetch((call) => {
    assert.ok(call.signal);
    observedSignals.push(call.signal);
    return new Response(null, { status: 204 });
  });

  await testWebDavConnection(settings, caller.signal, fetchImpl);

  assert.equal(observedSignals.length, 2);
  assert.equal(observedSignals.every((signal) => signal.aborted), true);
  assert.equal(observedSignals.every((signal) => signal.reason === abortReason), true);
});

test("runs as a standalone service without store or controller construction", async () => {
  const { calls, fetchImpl } = recordingFetch();

  await testWebDavConnection(settings, undefined, fetchImpl);

  assert.equal(calls.length, 2);
});
