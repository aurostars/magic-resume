import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import {
  createPinnedAddressTransport,
  type ImageProxyTransport,
} from "./image-proxy";

export type NodeImageRequest = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

export interface NodeImageTransportDependencies {
  resolve?: typeof dnsLookup;
  httpRequest?: NodeImageRequest;
  httpsRequest?: NodeImageRequest;
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function pinnedLookup(addresses: readonly string[]): RequestOptions["lookup"] {
  const records = addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 as const : 4 as const,
  }));
  return (_hostname, options, callback) => {
    if (typeof options === "object" && options.all) {
      callback(null, records);
      return;
    }
    const selected = records[0];
    callback(null, selected.address, selected.family);
  };
}

function connect(
  request: NodeImageRequest,
  target: URL,
  addresses: readonly string[],
  init: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = new Headers(init.headers);
    headers.set("Host", target.host);
    const options: RequestOptions = {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
      lookup: pinnedLookup(addresses),
      ...(target.protocol === "https:" ? { servername: target.hostname } : {}),
    };
    const clientRequest = request(target, options, (upstream) => {
      const body = Readable.toWeb(upstream) as ReadableStream<Uint8Array>;
      resolve(new Response(body, {
        status: upstream.statusCode ?? 502,
        headers: responseHeaders(upstream),
      }));
    });
    const abort = () => clientRequest.destroy(new DOMException("Aborted", "AbortError"));
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    clientRequest.once("error", reject);
    clientRequest.end();
  });
}

export function createNodeImageProxyTransport(
  dependencies: NodeImageTransportDependencies = {},
): ImageProxyTransport {
  const resolve = dependencies.resolve ?? dnsLookup;
  const requestHttp = dependencies.httpRequest ?? httpRequest;
  const requestHttps = dependencies.httpsRequest ?? httpsRequest;
  return createPinnedAddressTransport({
    async resolveAll(hostname) {
      const records = await resolve(hostname, { all: true, verbatim: true });
      return records.map((record) => record.address);
    },
    connectToValidatedAddresses(target, addresses, init) {
      return connect(
        target.protocol === "https:" ? requestHttps : requestHttp,
        target,
        addresses,
        init,
      );
    },
  });
}
