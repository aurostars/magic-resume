import { combineAbortSignals } from "../abort-signal";

export const MAX_IMAGE_RESPONSE_BYTES = 5 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_MS = 15_000;

const ERROR_MESSAGES = {
  invalidUrl: "Invalid image URL",
  blockedTarget: "Image target is not allowed",
  invalidContentType: "Upstream response is not an image",
  imageTooLarge: "Image exceeds the size limit",
  emptyImage: "Image response is empty",
  timeout: "Image request timed out",
  upstreamError: "Unable to fetch image",
} as const;

type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface ImageProxyTransport {
  fetch(target: URL, init: RequestInit): Promise<Response>;
}

export interface PinnedAddressTransportDependencies {
  /** Resolve every A/AAAA candidate before connecting. */
  resolveAll(hostname: string): Promise<readonly string[]>;
  /** Connect exclusively to one of addresses; implementations must not resolve target.hostname again. */
  connectToValidatedAddresses(
    target: URL,
    addresses: readonly string[],
    init: RequestInit,
  ): Promise<Response>;
}

export interface ImageProxyDependencies {
  transport: ImageProxyTransport;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}

class BlockedTargetError extends Error {}

function errorResponse(status: number, code: ErrorCode) {
  return Response.json({ error: ERROR_MESSAGES[code], code }, { status });
}

function parseIPv4(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : undefined;
}

function isBlockedIPv4(bytes: number[]) {
  const [a, b, c] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function expandIPv6(hostname: string): number[] | undefined {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!value.includes(":")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    /^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN,
  );
  return words.length === 8 && words.every(Number.isFinite) ? words : undefined;
}

function isGloballyRoutableIPv6(words: number[]) {
  // NAT64's well-known prefix is globally reachable only when its embedded IPv4 is.
  if (
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0)
  ) {
    return !isBlockedIPv4([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ]);
  }

  // Conservatively allow allocated global unicast (2000::/3), minus IANA
  // special-purpose blocks. Unknown or transition space stays fail-closed.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (
    (words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) ||
    words[0] === 0x2002
  ) {
    return false;
  }
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return false;
  return true;
}

function isGloballyRoutableAddress(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4 = parseIPv4(normalized);
  if (ipv4) return !isBlockedIPv4(ipv4);
  const ipv6 = expandIPv6(normalized);
  return ipv6 !== undefined && isGloballyRoutableIPv6(ipv6);
}

function isBlockedHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  return isIpAddress(normalized) && !isGloballyRoutableAddress(normalized);
}

function isIpAddress(hostname: string) {
  return parseIPv4(hostname) !== undefined || expandIPv6(hostname) !== undefined;
}

export function createPinnedAddressTransport(
  dependencies: PinnedAddressTransportDependencies,
): ImageProxyTransport {
  return {
    async fetch(target, init) {
      const addresses = isIpAddress(target.hostname)
        ? [target.hostname.replace(/^\[|\]$/g, "")]
        : await dependencies.resolveAll(target.hostname);
      if (
        addresses.length === 0 ||
        addresses.some((address) => !isIpAddress(address) || isBlockedHostname(address))
      ) {
        throw new BlockedTargetError();
      }
      return dependencies.connectToValidatedAddresses(target, [...addresses], init);
    },
  };
}

export function createCloudflareFetchTransport(
  fetcher?: typeof fetch,
): ImageProxyTransport {
  return {
    fetch: (target, init) => (fetcher ?? globalThis.fetch)(target, init),
  };
}

function parseTarget(rawUrl: string): URL | undefined {
  try {
    const target = new URL(rawUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.username ||
      target.password ||
      target.port ||
      isBlockedHostname(target.hostname)
    ) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

async function cancelBodySafely(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and must never replace the stable proxy error.
  }
}

async function cancelReaderSafely(reader: ReadableStreamDefaultReader<Uint8Array>) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort and must never replace the stable proxy error.
  }
}

async function imageResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.ok) {
    await cancelBodySafely(response);
    return errorResponse(502, "upstreamError");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    await cancelBodySafely(response);
    return errorResponse(415, "invalidContentType");
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_RESPONSE_BYTES) {
    await cancelBodySafely(response);
    return errorResponse(413, "imageTooLarge");
  }
  if (!response.body) return errorResponse(400, "emptyImage");

  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_RESPONSE_BYTES) {
        await cancelReaderSafely(reader);
        return errorResponse(413, "imageTooLarge");
      }
      chunks.push(value);
    }
    if (total === 0) {
      await cancelReaderSafely(reader);
      return errorResponse(400, "emptyImage");
    }
  } catch (error) {
    await cancelReaderSafely(reader);
    const aborted = signal.aborted ||
      (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
    return errorResponse(aborted ? 504 : 502, aborted ? "timeout" : "upstreamError");
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export async function handleImageProxy(
  request: Request,
  dependencies?: ImageProxyDependencies,
): Promise<Response> {
  const rawUrl = new URL(request.url).searchParams.get("url");
  if (!rawUrl) return errorResponse(400, "invalidUrl");

  const target = parseTarget(rawUrl);
  if (!target) {
    let validSyntax = false;
    try {
      const parsed = new URL(rawUrl);
      validSyntax = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      // The stable response intentionally omits parsing details.
    }
    return errorResponse(validSyntax ? 403 : 400, validSyntax ? "blockedTarget" : "invalidUrl");
  }

  const timeoutSignal = dependencies?.timeoutSignal ?? AbortSignal.timeout.bind(AbortSignal);
  const signal = combineAbortSignals([
    request.signal,
    timeoutSignal(IMAGE_PROXY_TIMEOUT_MS),
  ]);
  let current = target;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    let response: Response;
    try {
      if (!dependencies) throw new BlockedTargetError();
      response = await dependencies.transport.fetch(current, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          Referer: current.origin,
        },
      });
    } catch (error) {
      if (error instanceof BlockedTargetError) {
        return errorResponse(403, "blockedTarget");
      }
      const aborted = signal.aborted ||
        (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
      return errorResponse(aborted ? 504 : 502, aborted ? "timeout" : "upstreamError");
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return imageResponse(response, signal);
    }

    await cancelBodySafely(response);
    const location = response.headers.get("location");
    if (!location || redirects === 5) return errorResponse(502, "upstreamError");
    let redirected: URL;
    try {
      redirected = new URL(location, current);
    } catch {
      return errorResponse(502, "upstreamError");
    }
    const validated = parseTarget(redirected.href);
    if (!validated) return errorResponse(403, "blockedTarget");
    current = validated;
  }

  return errorResponse(502, "upstreamError");
}
