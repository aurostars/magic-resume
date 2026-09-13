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

export interface WebDavClientApi {
  options(path: string, signal?: AbortSignal): Promise<void>;
  propfind(path: string, signal?: AbortSignal): Promise<boolean>;
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
  ): Promise<void>;
  delete(path: string, signal?: AbortSignal): Promise<void>;
}

type RequestKind = "DEFAULT" | "DIRECTORY" | "MOVE";

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebDavError("UNKNOWN");
  }

  if (url.username || url.password) {
    throw new WebDavError("UNKNOWN");
  }

  const isLoopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLoopbackHttp) {
    throw new WebDavError("HTTPS_REQUIRED");
  }

  url.search = "";
  url.hash = "";
  return url;
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

export class WebDavClient implements WebDavClientApi {
  private readonly baseUrl: URL;
  private readonly authorization: string;

  constructor(
    private readonly config: WebDavClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = safeBaseUrl(config.baseUrl);
    this.authorization = basicAuthorization(config.username, config.password);
  }

  async options(path: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(path, { method: "OPTIONS" }, signal);
    this.requireSuccess(response);
  }

  async propfind(path: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.request(
      path,
      { method: "PROPFIND", headers: { Depth: "0" } },
      signal,
    );
    if (response.status === 404) return false;
    this.requireSuccess(response);
    return true;
  }

  async ensureDirectory(path: string, signal?: AbortSignal): Promise<void> {
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
    return (await this.getTextWithMetadata(path, signal))?.text ?? null;
  }

  async getTextWithMetadata(path: string, signal?: AbortSignal): Promise<RemoteText | null> {
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
  ): Promise<void> {
    const precondition = preconditionOrSignal instanceof AbortSignal
      ? undefined
      : preconditionOrSignal;
    const requestSignal = preconditionOrSignal instanceof AbortSignal
      ? preconditionOrSignal
      : signal;
    const destinationUrl = this.remoteUrl(destination).toString();
    const headers = new Headers({
      Destination: destinationUrl,
      Overwrite: precondition?.kind === "missing" ? "F" : "T",
    });
    if (precondition?.kind === "match") {
      headers.set("If", `<${destinationUrl}> ([${precondition.etag}])`);
    }
    const response = await this.request(
      source,
      { method: "MOVE", headers },
      requestSignal,
    );
    this.requireSuccess(response, "MOVE");
  }

  async delete(path: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.request(path, { method: "DELETE" }, signal);
    } catch {
      // Temporary-file cleanup must not mask the primary sync result.
    }
  }

  private assertSafePath(path: string): void {
    if (path.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new WebDavError("UNKNOWN");
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
