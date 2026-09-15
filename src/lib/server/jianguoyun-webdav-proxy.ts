export type JianguoyunWebDavMethod =
  | "OPTIONS" | "PROPFIND" | "MKCOL" | "GET" | "PUT" | "DELETE" | "MOVE";

export interface JianguoyunProxyRequest {
  method: JianguoyunWebDavMethod;
  pathSegments: string[];
  pathTrailingSlash: boolean;
  destinationSegments?: string[];
  destinationTrailingSlash?: boolean;
  username: string;
  password: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface JianguoyunProxyDependencies {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const JIANGUOYUN_ORIGIN = "https://dav.jianguoyun.com";
const JIANGUOYUN_ROOT = "/dav/";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PATH_SEGMENTS = 256;
const MAX_PATH_SEGMENT_LENGTH = 1024;
const ALLOWED_METHODS = new Set<JianguoyunWebDavMethod>([
  "OPTIONS", "PROPFIND", "MKCOL", "GET", "PUT", "DELETE", "MOVE",
]);
const REQUEST_HEADERS = new Set([
  "depth", "overwrite", "if", "if-match", "if-none-match", "content-type",
]);
const RESPONSE_HEADERS = new Set([
  "dav", "etag", "last-modified", "content-type", "allow",
]);

function jsonError(status: number, error: string, code: string): Response {
  return Response.json({ error, code }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function invalidRequest(): Response {
  return jsonError(400, "Invalid Jianguoyun WebDAV proxy request", "invalidWebdavProxyRequest");
}

function requestTooLarge(): Response {
  return jsonError(413, "Jianguoyun WebDAV proxy request is too large", "webdavProxyRequestTooLarge");
}

function proxyFailed(): Response {
  return jsonError(502, "Jianguoyun WebDAV proxy failed", "webdavProxyFailed");
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; errors must not replace the stable proxy response.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; errors must not replace the stable size/error response.
  }
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers({ "Cache-Control": "no-store" });
  upstream.headers.forEach((value, name) => {
    if (RESPONSE_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  return headers;
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array | undefined> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        cancelReader(reader);
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    cancelReader(reader);
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return bytes;
}

function fixedUpstreamUrl(
  segments: unknown,
  trailingSlash: unknown,
  username?: string,
  password?: string,
): URL | undefined {
  if (
    !Array.isArray(segments)
    || segments.length > MAX_PATH_SEGMENTS
    || (segments.length === 0 && trailingSlash !== true)
    || (trailingSlash !== undefined && typeof trailingSlash !== "boolean")
  ) {
    return undefined;
  }

  const encodedSegments: string[] = [];
  for (const segment of segments) {
    if (
      typeof segment !== "string"
      || segment.length === 0
      || segment.length > MAX_PATH_SEGMENT_LENGTH
      || segment === "."
      || segment === ".."
      || segment.includes("/")
      || segment.includes("\\")
      || /[\u0000-\u001F\u007F-\u009F]/.test(segment)
      || (username !== undefined && segment.includes(username))
      || (password !== undefined && segment.includes(password))
    ) {
      return undefined;
    }
    try {
      encodedSegments.push(encodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }

  const relativePath = encodedSegments.join("/") + (trailingSlash ? "/" : "");
  const target = new URL(relativePath, `${JIANGUOYUN_ORIGIN}${JIANGUOYUN_ROOT}`);
  if (target.origin !== JIANGUOYUN_ORIGIN || !target.pathname.startsWith(JIANGUOYUN_ROOT)) {
    return undefined;
  }
  return target;
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `Basic ${btoa(binary)}`;
}

function isProxyRequest(value: unknown): value is JianguoyunProxyRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<JianguoyunProxyRequest> & Record<string, unknown>;
  const hasDestination = candidate.destinationSegments !== undefined
    || candidate.destinationTrailingSlash !== undefined;
  return typeof candidate.method === "string"
    && ALLOWED_METHODS.has(candidate.method as JianguoyunWebDavMethod)
    && Array.isArray(candidate.pathSegments)
    && typeof candidate.pathTrailingSlash === "boolean"
    && !("path" in candidate)
    && !("pathEncoding" in candidate)
    && (candidate.destinationSegments === undefined || Array.isArray(candidate.destinationSegments))
    && (
      candidate.destinationTrailingSlash === undefined
      || typeof candidate.destinationTrailingSlash === "boolean"
    )
    && (
      candidate.method === "MOVE"
        ? Array.isArray(candidate.destinationSegments)
          && typeof candidate.destinationTrailingSlash === "boolean"
        : !hasDestination
    )
    && typeof candidate.username === "string"
    && candidate.username.length > 0
    && !/[:\u0000-\u001F\u007F-\u009F]/.test(candidate.username)
    && typeof candidate.password === "string"
    && candidate.password.length > 0
    && (candidate.body === undefined || typeof candidate.body === "string")
    && (candidate.headers === undefined || (
      candidate.headers !== null
      && typeof candidate.headers === "object"
      && !Array.isArray(candidate.headers)
      && Object.values(candidate.headers).every((header) => typeof header === "string")
      && !Object.keys(candidate.headers).some((name) => name.toLowerCase() === "destination")
    ));
}

export async function handleJianguoyunWebDavProxy(
  request: Request,
  dependencies: JianguoyunProxyDependencies = {},
): Promise<Response> {
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return invalidRequest();
    if (length > MAX_BODY_BYTES) {
      cancelBody(request.body);
      return requestTooLarge();
    }
  }

  let payload: unknown;
  try {
    const bytes = await readBodyWithLimit(request.body);
    if (!bytes) return requestTooLarge();
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalidRequest();
  }

  if (!isProxyRequest(payload)) return invalidRequest();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const target = fixedUpstreamUrl(
      payload.pathSegments,
      payload.pathTrailingSlash,
      payload.username,
      payload.password,
    );
    if (!target) return invalidRequest();

    const headers = new Headers();
    for (const [name, value] of Object.entries(payload.headers ?? {})) {
      if (REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    }

    if (payload.method === "MOVE") {
      const destination = fixedUpstreamUrl(
        payload.destinationSegments,
        payload.destinationTrailingSlash,
        payload.username,
        payload.password,
      );
      if (!destination) return invalidRequest();
      headers.set("Destination", destination.href);
    }
    headers.set("Authorization", basicAuthorization(payload.username, payload.password));

    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10_000);
    const upstream = await (dependencies.fetchImpl ?? fetch)(target, {
      method: payload.method,
      headers,
      body: payload.body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      cancelBody(upstream.body);
      return proxyFailed();
    }
    if (upstream.status < 200) {
      cancelBody(upstream.body);
      return proxyFailed();
    }
    if (upstream.status >= 400) {
      cancelBody(upstream.body);
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream),
      });
    }

    const body = await readBodyWithLimit(upstream.body);
    if (!body) return proxyFailed();

    return new Response(body.byteLength === 0 ? null : body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    });
  } catch {
    return proxyFailed();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
