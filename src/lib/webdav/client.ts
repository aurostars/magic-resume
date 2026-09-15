import { getApiRequestUrl } from "../../config/runtime-endpoints";
import { WebDavError, type WebDavErrorCode } from "./errors";

export interface WebDavClientConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export type RemotePrecondition =
  | { kind: "match"; etag: string }
  | { kind: "missing" };

export interface RemoteText {
  text: string;
  etag: string | null;
}

export interface RemoteCollectionFile {
  path: string;
  etag: string | null;
}

export interface WebDavCapabilities {
  conditionalMove: boolean;
}

export interface WebDavClientApi {
  options(path: string, signal?: AbortSignal): Promise<WebDavCapabilities>;
  propfind(path: string, signal?: AbortSignal): Promise<boolean>;
  listCollection(path: string, signal?: AbortSignal): Promise<RemoteCollectionFile[]>;
  ensureDirectory(path: string, signal?: AbortSignal): Promise<void>;
  getText(path: string, signal?: AbortSignal): Promise<string | null>;
  getTextWithMetadata(path: string, signal?: AbortSignal): Promise<RemoteText | null>;
  putText(
    path: string,
    content: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void>;
  move(
    source: string,
    destination: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
    sourceEtag?: string,
  ): Promise<void>;
  delete(
    path: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void>;
}

type RequestKind = "DEFAULT" | "DIRECTORY" | "MOVE";

const EDGE_IGNORABLE = /^[\s\u200B\u200C\u200D\u2060\uFEFF]+|[\s\u200B\u200C\u200D\u2060\uFEFF]+$/gu;
const INVISIBLE_FORMAT_CHARACTER = /[\u200B\u200C\u200D\u2060\uFEFF]/;

export function normalizeWebDavBaseUrl(value: string): URL {
  const normalizedValue = value.replace(EDGE_IGNORABLE, "");
  if (INVISIBLE_FORMAT_CHARACTER.test(normalizedValue)) {
    throw new WebDavError("UNKNOWN");
  }

  let url: URL;
  try {
    url = new URL(normalizedValue);
  } catch {
    throw new WebDavError("UNKNOWN");
  }

  if (url.protocol !== "https:") {
    throw new WebDavError("HTTPS_REQUIRED");
  }

  if (url.username || url.password || url.port) {
    throw new WebDavError("UNKNOWN");
  }

  const forbiddenWorkerSuffix = ["workers", "dev"].join(".");
  const exactHostname = url.hostname.toLowerCase();
  const hostname = exactHostname.replace(/\.$/, "");
  if (hostname === forbiddenWorkerSuffix || hostname.endsWith(`.${forbiddenWorkerSuffix}`)) {
    throw new WebDavError("UNKNOWN");
  }

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (
    exactHostname === "dav.jianguoyun.com"
    && url.pathname === "/dav"
  ) {
    url.pathname = "/dav/";
  }
  return url;
}

export type WebDavFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function isJianguoyunWebDavUrl(value: URL): boolean {
  return value.protocol === "https:"
    && value.hostname === "dav.jianguoyun.com"
    && value.port === ""
    && value.pathname.startsWith("/dav/");
}

interface JianguoyunLogicalPath {
  segments: string[];
  trailingSlash: boolean;
}

function jianguoyunLogicalPath(value: URL): JianguoyunLogicalPath {
  if (!isJianguoyunWebDavUrl(value)) throw new WebDavError("UNKNOWN");
  const relativePath = value.pathname.slice("/dav/".length);
  const trailingSlash = relativePath === "" || relativePath.endsWith("/");
  const encodedSegments = (trailingSlash ? relativePath.slice(0, -1) : relativePath).split("/");
  if (encodedSegments.length === 1 && encodedSegments[0] === "") {
    return { segments: [], trailingSlash };
  }

  try {
    return {
      segments: encodedSegments.map((segment) => decodeURIComponent(segment)),
      trailingSlash,
    };
  } catch {
    throw new WebDavError("UNKNOWN");
  }
}

const JIANGUOYUN_REQUEST_HEADERS = new Set([
  "depth",
  "overwrite",
  "if",
  "if-match",
  "if-none-match",
  "content-type",
]);

export function createJianguoyunProxyFetch(
  config: WebDavClientConfig,
  fetchImpl: typeof fetch = fetch,
): WebDavFetch {
  return async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      throw new WebDavError("UNKNOWN");
    }
    const target = new URL(request.url);
    const path = jianguoyunLogicalPath(target);
    const headers = new Headers(request.headers);
    const destination = headers.get("Destination");
    const destinationPath = destination === null
      ? null
      : jianguoyunLogicalPath(new URL(destination));
    headers.delete("Destination");

    const forwardedHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (JIANGUOYUN_REQUEST_HEADERS.has(name)) forwardedHeaders[name] = value;
    });
    const envelope: Record<string, unknown> = {
      method: request.method,
      pathSegments: path.segments,
      pathTrailingSlash: path.trailingSlash,
      username: config.username,
      password: config.password,
    };
    if (destinationPath !== null) {
      envelope.destinationSegments = destinationPath.segments;
      envelope.destinationTrailingSlash = destinationPath.trailingSlash;
    }
    if (Object.keys(forwardedHeaders).length > 0) envelope.headers = forwardedHeaders;
    if (request.body !== null) envelope.body = await request.text();

    return fetchImpl(getApiRequestUrl("/api/webdav/jianguoyun"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify(envelope),
      signal: request.signal,
    });
  };
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return `Basic ${btoa(binary)}`;
}

function statusError(status: number, kind: RequestKind): WebDavError {
  let code: WebDavErrorCode;
  if (status === 412 || status === 423) code = "REMOTE_CAS_MISMATCH";
  else if (status === 401) code = "AUTH";
  else if (status === 403) code = "FORBIDDEN";
  else if (status === 404) code = "NOT_FOUND";
  else if (status === 507) code = "QUOTA";
  else if (kind === "MOVE" && (status === 405 || status === 501)) {
    code = "MOVE_UNSUPPORTED";
  } else if (status >= 500) code = "SERVER";
  else if (kind === "DIRECTORY") code = "DIRECTORY";
  else code = "UNKNOWN";
  return new WebDavError(code, status);
}

interface XmlElement {
  qualifiedName: string;
  localName: string;
  namespaceUri: string | null;
  namespaces: Map<string, string>;
  children: XmlElement[];
  text: string;
}

function decodeXmlText(value: string): string {
  if (/&(?!#\d+;|#x[0-9a-f]+;|amp;|lt;|gt;|quot;|apos;)/i.test(value)) {
    throw new WebDavError("UNKNOWN");
  }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (entity, decimal, hex) => {
    if (decimal || hex) {
      const codePoint = decimal ? Number(decimal) : Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new WebDavError("UNKNOWN");
      }
      return String.fromCodePoint(codePoint);
    }
    const named: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    return named[entity.toLowerCase()];
  });
}

function parseXml(xml: string): XmlElement {
  if (/<!DOCTYPE/i.test(xml)) throw new WebDavError("UNKNOWN");
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let cursor = 0;

  while (cursor < xml.length) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) {
      if (stack.length > 0) stack[stack.length - 1].text += decodeXmlText(xml.slice(cursor));
      break;
    }
    if (stack.length > 0) {
      stack[stack.length - 1].text += decodeXmlText(xml.slice(cursor, open));
    } else if (xml.slice(cursor, open).trim() !== "") {
      throw new WebDavError("UNKNOWN");
    }

    if (xml.startsWith("<!--", open)) {
      const close = xml.indexOf("-->", open + 4);
      if (close === -1) throw new WebDavError("UNKNOWN");
      cursor = close + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", open)) {
      if (stack.length === 0) throw new WebDavError("UNKNOWN");
      const close = xml.indexOf("]]>", open + 9);
      if (close === -1) throw new WebDavError("UNKNOWN");
      stack[stack.length - 1].text += xml.slice(open + 9, close);
      cursor = close + 3;
      continue;
    }
    if (xml.startsWith("<?", open)) {
      const close = xml.indexOf("?>", open + 2);
      if (close === -1) throw new WebDavError("UNKNOWN");
      cursor = close + 2;
      continue;
    }
    if (xml.startsWith("</", open)) {
      const close = xml.indexOf(">", open + 2);
      if (close === -1) throw new WebDavError("UNKNOWN");
      const qualifiedName = xml.slice(open + 2, close).trim();
      const current = stack.pop();
      if (!current || current.qualifiedName !== qualifiedName) throw new WebDavError("UNKNOWN");
      cursor = close + 1;
      continue;
    }
    if (xml.startsWith("<!", open)) throw new WebDavError("UNKNOWN");

    let close = open + 1;
    let quote = "";
    for (; close < xml.length; close += 1) {
      const character = xml[close];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (close === xml.length || quote) throw new WebDavError("UNKNOWN");

    let source = xml.slice(open + 1, close).trim();
    const selfClosing = source.endsWith("/");
    if (selfClosing) source = source.slice(0, -1).trim();
    const nameMatch = source.match(/^([\w.-]+(?::[\w.-]+)?)(?:\s|$)/);
    if (!nameMatch) throw new WebDavError("UNKNOWN");
    const qualifiedName = nameMatch[1];
    const parent = stack[stack.length - 1];
    const namespaces = new Map(parent?.namespaces ?? []);
    const attributes = source.slice(qualifiedName.length);
    const attributePattern = /\s+([\w.-]+(?::[\w.-]+)?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attributeCursor = 0;
    while (attributeCursor < attributes.length) {
      attributePattern.lastIndex = attributeCursor;
      const attribute = attributePattern.exec(attributes);
      if (!attribute || attributes.slice(attributeCursor, attribute.index).trim() !== "") {
        if (attributes.slice(attributeCursor).trim() === "") break;
        throw new WebDavError("UNKNOWN");
      }
      attributeCursor = attributePattern.lastIndex;
      const value = decodeXmlText(attribute[2] ?? attribute[3]);
      if (attribute[1] === "xmlns") namespaces.set("", value);
      else if (attribute[1].startsWith("xmlns:")) namespaces.set(attribute[1].slice(6), value);
    }

    const separator = qualifiedName.indexOf(":");
    const prefix = separator === -1 ? "" : qualifiedName.slice(0, separator);
    const element: XmlElement = {
      qualifiedName,
      localName: separator === -1 ? qualifiedName : qualifiedName.slice(separator + 1),
      namespaceUri: namespaces.get(prefix) ?? null,
      namespaces,
      children: [],
      text: "",
    };
    if (parent) parent.children.push(element);
    else if (root) throw new WebDavError("UNKNOWN");
    else root = element;
    if (!selfClosing) stack.push(element);
    cursor = close + 1;
  }

  if (!root || stack.length > 0) throw new WebDavError("UNKNOWN");
  return root;
}

const DAV_NAMESPACE = "DAV:";
const davChildren = (element: XmlElement, localName: string): XmlElement[] =>
  element.children.filter((child) =>
    child.namespaceUri === DAV_NAMESPACE && child.localName.toLowerCase() === localName
  );
const davChild = (element: XmlElement, localName: string): XmlElement | null =>
  davChildren(element, localName)[0] ?? null;

export class WebDavClient implements WebDavClientApi {
  private readonly baseUrl: URL;
  private readonly authorization: string;
  private readonly fetchImpl: WebDavFetch;

  constructor(
    private readonly config: WebDavClientConfig,
    fetchImpl?: typeof fetch,
  ) {
    this.baseUrl = normalizeWebDavBaseUrl(config.baseUrl);
    this.authorization = basicAuthorization(config.username, config.password);
    this.fetchImpl = fetchImpl
      ?? (isJianguoyunWebDavUrl(this.baseUrl) ? createJianguoyunProxyFetch(config) : fetch);
  }

  async options(path: string, signal?: AbortSignal): Promise<WebDavCapabilities> {
    this.assertSafePath(path);
    const response = await this.request(path, { method: "OPTIONS" }, signal);
    this.requireSuccess(response);
    const davTokens = (response.headers.get("DAV") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase());
    const allowedMethods = new Set((response.headers.get("Allow") ?? "")
      .split(",")
      .map((method) => method.trim().toUpperCase()));
    return {
      conditionalMove: davTokens.includes("1") &&
        allowedMethods.has("MOVE") && allowedMethods.has("DELETE"),
    };
  }

  async propfind(path: string, signal?: AbortSignal): Promise<boolean> {
    this.assertSafePath(path);
    const response = await this.request(
      path,
      { method: "PROPFIND", headers: { Depth: "0" } },
      signal,
    );
    if (response.status === 404) return false;
    this.requireSuccess(response);
    return true;
  }

  async listCollection(path: string, signal?: AbortSignal): Promise<RemoteCollectionFile[]> {
    this.assertSafePath(path);
    const collectionUrl = this.remoteUrl(path);
    if (!collectionUrl.pathname.endsWith("/")) throw new WebDavError("UNKNOWN");
    return this.request(
      path,
      { method: "PROPFIND", headers: { Depth: "1" } },
      signal,
      async (response) => {
        this.requireSuccess(response);
        const document = parseXml(await response.text());
        if (
          document.namespaceUri !== DAV_NAMESPACE ||
          document.localName.toLowerCase() !== "multistatus"
        ) {
          throw new WebDavError("UNKNOWN");
        }
        const files: RemoteCollectionFile[] = [];
        for (const item of davChildren(document, "response")) {
          const hrefElements = davChildren(item, "href");
          if (hrefElements.length !== 1 || hrefElements[0].children.length > 0) {
            throw new WebDavError("UNKNOWN");
          }
          const href = hrefElements[0].text.trim();
          if (href === "") throw new WebDavError("UNKNOWN");

          let resourceUrl: URL;
          try {
            resourceUrl = new URL(href, collectionUrl);
          } catch {
            throw new WebDavError("UNKNOWN");
          }
          if (
            resourceUrl.origin !== collectionUrl.origin ||
            !resourceUrl.pathname.startsWith(collectionUrl.pathname)
          ) {
            throw new WebDavError("UNKNOWN");
          }

          const encodedRelativePath = resourceUrl.pathname.slice(collectionUrl.pathname.length);
          if (encodedRelativePath === "") continue;
          let relativePath: string;
          try {
            relativePath = decodeURIComponent(encodedRelativePath);
          } catch {
            throw new WebDavError("UNKNOWN");
          }

          const properties = davChildren(item, "propstat")
            .map((propstat) => davChild(propstat, "prop"))
            .filter((prop): prop is XmlElement => prop !== null);
          const isCollection = properties.some((prop) => {
            const resourceType = davChild(prop, "resourcetype");
            return resourceType !== null && davChild(resourceType, "collection") !== null;
          });
          if (relativePath.includes("/") || isCollection) continue;
          const etagElement = properties
            .map((prop) => davChild(prop, "getetag"))
            .find((etag): etag is XmlElement => etag !== null);
          if (etagElement?.children.length) throw new WebDavError("UNKNOWN");
          files.push({ path: relativePath, etag: etagElement?.text.trim() || null });
        }
        return files;
      },
    );
  }

  async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
    this.assertSafePath(path);
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      const response = await this.request(
        `${current}/`,
        { method: "MKCOL" },
        signal,
      );
      if (response.status !== 201 && response.status !== 405) {
        throw statusError(response.status, "DIRECTORY");
      }
    }
  }

  async getText(path: string, signal?: AbortSignal): Promise<string | null> {
    this.assertSafePath(path);
    return (await this.getTextWithMetadata(path, signal))?.text ?? null;
  }

  async getTextWithMetadata(path: string, signal?: AbortSignal): Promise<RemoteText | null> {
    this.assertSafePath(path);
    return this.request(
      path,
      { method: "GET" },
      signal,
      async (response) => {
        if (response.status === 404) return null;
        this.requireSuccess(response);
        return { text: await response.text(), etag: response.headers.get("ETag") };
      },
    );
  }

  async putText(
    path: string,
    content: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertSafePath(path);
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    const requestSignal = preconditionOrSignal instanceof AbortSignal
      ? preconditionOrSignal
      : signal;
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    if (precondition?.kind === "match") headers.set("If-Match", precondition.etag);
    else if (precondition?.kind === "missing") headers.set("If-None-Match", "*");
    const response = await this.request(
      path,
      { method: "PUT", headers, body: content },
      requestSignal,
    );
    this.requireSuccess(response);
  }

  async move(
    source: string,
    destination: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
    sourceEtag?: string,
  ): Promise<void> {
    this.assertSafePath(source);
    this.assertSafePath(destination);
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    const requestSignal = preconditionOrSignal instanceof AbortSignal
      ? preconditionOrSignal
      : signal;
    const sourceUrl = this.remoteUrl(source).toString();
    const destinationUrl = this.remoteUrl(destination).toString();
    const headers = new Headers({
      Destination: destinationUrl,
      Overwrite: precondition?.kind === "missing" ? "F" : "T",
    });
    const taggedConditions: string[] = [];
    if (sourceEtag) taggedConditions.push(`<${sourceUrl}> ([${sourceEtag}])`);
    if (precondition?.kind === "match") {
      taggedConditions.push(`<${destinationUrl}> ([${precondition.etag}])`);
    }
    if (taggedConditions.length > 0) headers.set("If", taggedConditions.join(" "));
    const response = await this.request(
      source,
      { method: "MOVE", headers },
      requestSignal,
    );
    this.requireSuccess(response, "MOVE");
  }

  async delete(
    path: string,
    preconditionOrSignal?: RemotePrecondition | AbortSignal,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertSafePath(path);
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    const requestSignal = preconditionOrSignal instanceof AbortSignal
      ? preconditionOrSignal
      : signal;
    const headers = new Headers();
    if (precondition?.kind === "match") headers.set("If-Match", precondition.etag);
    const response = await this.request(path, { method: "DELETE", headers }, requestSignal);
    this.requireSuccess(response);
  }

  private assertSafePath(path: string): void {
    for (const segment of path.split("/")) {
      if (segment === "." || segment === "..") throw new WebDavError("UNKNOWN");
    }
  }

  private remoteUrl(path: string): URL {
    this.assertSafePath(path);
    const basePath = this.baseUrl.pathname.replace(/\/$/, "");
    const encodedPath = path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const remotePath = encodedPath.startsWith("/") ? encodedPath : `/${encodedPath}`;
    const url = new URL(this.baseUrl.toString());
    url.pathname = `${basePath}${remotePath}`;
    return url;
  }

  private async request<T = Response>(
    path: string,
    init: RequestInit,
    callerSignal?: AbortSignal,
    consume: (response: Response) => T | Promise<T> = (response) => response as T,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) abortFromCaller();
    else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);

    const headers = new Headers(init.headers);
    headers.set("Authorization", this.authorization);

    try {
      const response = await this.fetchImpl(this.remoteUrl(path), {
        ...init,
        headers,
        signal: controller.signal,
      });
      return await consume(response);
    } catch (error) {
      if (error instanceof WebDavError) throw error;
      if (timedOut) throw new WebDavError("TIMEOUT");
      if (callerSignal?.aborted) throw new WebDavError("ABORTED");
      throw new WebDavError("NETWORK");
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private requireSuccess(response: Response, kind: RequestKind = "DEFAULT"): void {
    if (!response.ok) throw statusError(response.status, kind);
  }
}
