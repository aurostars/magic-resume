import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  createNodeImageProxyTransport,
  type NodeImageRequest,
} from "../src/lib/server/node-image-transport";
import { handleImageProxy } from "../src/lib/server/image-proxy";

function successfulRequest(capture: (options: Record<string, unknown>) => void): NodeImageRequest {
  return (_url, options, onResponse) => {
    capture(options as Record<string, unknown>);
    const request = new EventEmitter() as EventEmitter & {
      end(): void;
      destroy(error?: Error): void;
    };
    request.end = () => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = 200;
      response.headers = { "content-type": "image/png" };
      onResponse(response);
      response.end(Buffer.from([137, 80, 78, 71]));
    };
    request.destroy = (error) => {
      if (error) request.emit("error", error);
    };
    return request;
  };
}

test("Node transport validates every DNS result and pins the socket lookup without ambient fetch", async () => {
  let dnsCalls = 0;
  let requestOptions: Record<string, unknown> | undefined;
  const ambientFetch = globalThis.fetch;
  globalThis.fetch = (async () => assert.fail("Node image transport must not use ambient fetch")) as typeof fetch;
  try {
    const transport = createNodeImageProxyTransport({
      resolve: async (hostname) => {
        dnsCalls += 1;
        assert.equal(hostname, "images.example.test");
        return [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ];
      },
      httpRequest: successfulRequest((options) => { requestOptions = options; }),
      httpsRequest: successfulRequest((options) => { requestOptions = options; }),
    });
    const response = await handleImageProxy(
      new Request("https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fphoto.png"),
      { transport },
    );

    assert.equal(response.status, 200);
    assert.equal(dnsCalls, 1);
    assert.equal(requestOptions?.servername, "images.example.test");
    assert.equal(requestOptions?.headers instanceof Object, true);
    let pinnedLookups = 0;
    const lookup = requestOptions?.lookup as (
      hostname: string,
      options: { all?: boolean },
      callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) => void;
    lookup("images.example.test", { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ]);
      pinnedLookups += 1;
    });
    assert.equal(pinnedLookups, 1);
    assert.equal(dnsCalls, 1, "socket lookup must not perform a second DNS resolution");
  } finally {
    globalThis.fetch = ambientFetch;
  }
});

test("Node transport rejects private, mapped-private, and redirected private DNS answers before connecting", async () => {
  for (const addresses of [
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "::ffff:10.0.0.1", family: 6 }],
  ]) {
    let requests = 0;
    const transport = createNodeImageProxyTransport({
      resolve: async () => addresses,
      httpRequest: successfulRequest(() => { requests += 1; }),
      httpsRequest: successfulRequest(() => { requests += 1; }),
    });
    const response = await handleImageProxy(
      new Request("https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fphoto.png"),
      { transport },
    );
    assert.equal(response.status, 403);
    assert.equal(requests, 0);
  }

  let resolution = 0;
  let requests = 0;
  const redirectingRequest: NodeImageRequest = (_url, _options, onResponse) => {
    requests += 1;
    const request = new EventEmitter() as EventEmitter & { end(): void; destroy(error?: Error): void };
    request.end = () => {
      const response = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string> };
      response.statusCode = 302;
      response.headers = { location: "https://images.example.test/private.png" };
      onResponse(response);
      response.end();
    };
    request.destroy = (error) => { if (error) request.emit("error", error); };
    return request;
  };
  const transport = createNodeImageProxyTransport({
    resolve: async () => (++resolution === 1
      ? [{ address: "93.184.216.34", family: 4 as const }]
      : [{ address: "127.0.0.1", family: 4 as const }]),
    httpRequest: redirectingRequest,
    httpsRequest: redirectingRequest,
  });
  const response = await handleImageProxy(
    new Request("https://app.example/api/proxy/image?url=https%3A%2F%2Fimages.example.test%2Fphoto.png"),
    { transport },
  );
  assert.equal(response.status, 403);
  assert.equal(resolution, 2);
  assert.equal(requests, 1);
});
