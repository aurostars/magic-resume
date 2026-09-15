export type JianguoyunWebDavMethod =
  | "OPTIONS" | "PROPFIND" | "MKCOL" | "GET" | "PUT" | "DELETE" | "MOVE";

export interface JianguoyunProxyRequest {
  method: JianguoyunWebDavMethod;
  path: string;
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
const ALLOWED_METHODS = new Set<JianguoyunWebDavMethod>([
  "OPTIONS", "PROPFIND", "MKCOL", "GET", "PUT", "DELETE", "MOVE",
]);
const REQUEST_HEADERS = new Set([
  "depth", "destination", "overwrite", "if", "if-match", "if-none-match", "content-type",
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

function proxyFailed(): Response {
  return jsonError(502, "Jianguoyun WebDAV proxy failed", "webdavProxyFailed");
}

function decodePathSegment(segment: string): string | undefined {
  let decoded = segment;
  try {
    for (;;) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) return decoded;
      decoded = next;
    }
  } catch {
    return undefined;
  }
}

function fixedUpstreamUrl(
  path: unknown,
  username?: string,
  password?: string,
): URL | undefined {
  if (
    typeof path !== "string"
    || path.startsWith("/")
    || path.startsWith("\\")
    || /^[A-Za-z][A-Za-z\d+.-]*:/.test(path)
  ) {
    return undefined;
  }

  const encodedSegments: string[] = [];
  for (const segment of path.split("/")) {
    const decoded = decodePathSegment(segment);
    if (
      decoded === undefined
      || decoded === "."
      || decoded === ".."
      || decoded.includes("/")
      || decoded.includes("\\")
      || decoded.includes("\0")
      || (encodedSegments.length === 0 && /^[A-Za-z][A-Za-z\d+.-]*:/.test(decoded))
      || (username !== undefined && decoded.includes(username))
      || (password !== undefined && decoded.includes(password))
    ) {
      return undefined;
    }
    encodedSegments.push(encodeURIComponent(decoded));
  }

  const target = new URL(encodedSegments.join("/"), `${JIANGUOYUN_ORIGIN}${JIANGUOYUN_ROOT}`);
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
  const candidate = value as Partial<JianguoyunProxyRequest>;
  return typeof candidate.method === "string"
    && ALLOWED_METHODS.has(candidate.method as JianguoyunWebDavMethod)
    && typeof candidate.path === "string"
    && typeof candidate.username === "string"
    && candidate.username.length > 0
    && typeof candidate.password === "string"
    && candidate.password.length > 0
    && (candidate.body === undefined || typeof candidate.body === "string")
    && (candidate.headers === undefined || (
      candidate.headers !== null
      && typeof candidate.headers === "object"
      && !Array.isArray(candidate.headers)
      && Object.values(candidate.headers).every((header) => typeof header === "string")
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
      return jsonError(413, "Jianguoyun WebDAV proxy request is too large", "webdavProxyRequestTooLarge");
    }
  }

  let payload: unknown;
  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) {
      return jsonError(413, "Jianguoyun WebDAV proxy request is too large", "webdavProxyRequestTooLarge");
    }
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return invalidRequest();
  }

  if (!isProxyRequest(payload)) return invalidRequest();
  const target = fixedUpstreamUrl(payload.path, payload.username, payload.password);
  if (!target) return invalidRequest();

  const headers = new Headers();
  for (const [name, value] of Object.entries(payload.headers ?? {})) {
    if (REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }

  if (payload.method === "MOVE" && headers.has("Destination")) {
    const destination = fixedUpstreamUrl(headers.get("Destination"));
    if (!destination) return invalidRequest();
    headers.set("Destination", destination.href);
  }
  headers.set("Authorization", basicAuthorization(payload.username, payload.password));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 10_000);
  try {
    const upstream = await (dependencies.fetchImpl ?? fetch)(target, {
      method: payload.method,
      headers,
      body: payload.body,
      redirect: "manual",
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) return proxyFailed();

    const body = await upstream.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return proxyFailed();

    const responseHeaders = new Headers({ "Cache-Control": "no-store" });
    upstream.headers.forEach((value, name) => {
      if (RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.set(name, value);
    });
    return new Response(body.byteLength === 0 ? null : body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return proxyFailed();
  } finally {
    clearTimeout(timeout);
  }
}
