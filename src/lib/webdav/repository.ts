import type {
  RemotePrecondition,
  RemoteText,
  WebDavClientApi,
} from "./client";
import { WebDavError } from "./errors";
import { parseResumeJson } from "./resume-codec";

const DEFAULT_ROOT = "/magic-resume/";
const MANIFEST_FILE = "manifest.json";
const OBJECTS_DIRECTORY = "objects/";
const RESUMES_DIRECTORY = "resumes/";
const TRASH_DIRECTORY = "trash/";
const SAFE_TOKEN = /^[A-Za-z0-9._-]+$/;
const HASH_FILE = /^[0-9a-f]{64}\.json$/;

export interface RemoteTextFile {
  path: string;
  text: string;
  etag: string | null;
}

export interface RemoteResumeCandidate {
  path: string;
  etag: string | null;
}

export interface ManifestPublishOperation {
  sourcePath: string;
  sourceEtag: string;
  destinationPrecondition: RemotePrecondition;
}

export interface WebDavResumeRepositoryOptions {
  deviceId: string;
  remoteDirectory?: string;
  createOperationId?: () => string;
}

function normalizedRoot(path: string): string {
  if (!path.startsWith("/") || !path.endsWith("/")) throw new WebDavError("UNKNOWN");
  const segments = path.split("/").slice(1, -1);
  if (segments.length === 0 || segments.some((segment) =>
    segment === "" || segment === "." || segment === ".."
  )) {
    throw new WebDavError("UNKNOWN");
  }
  return `/${segments.join("/")}/`;
}

function assertSafeToken(value: string): void {
  if (!SAFE_TOKEN.test(value)) throw new WebDavError("UNKNOWN");
}

function assertResumePath(path: string): void {
  if (path.startsWith("/") || !path.endsWith(".json") || path.includes(".tmp-")) {
    throw new WebDavError("UNKNOWN");
  }
  const segments = path.split("/");
  const safe = segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
  const isMirror = safe && segments.length === 2 &&
    (segments[0] === "resumes" || segments[0] === "trash");
  const isObject = safe && segments.length === 3 && segments[0] === "objects" &&
    SAFE_TOKEN.test(segments[1]) && HASH_FILE.test(segments[2]);
  if (!isMirror && !isObject) throw new WebDavError("UNKNOWN");
}

function preconditionFor(expectedEtag: string | null | undefined): RemotePrecondition {
  return expectedEtag == null
    ? { kind: "missing" }
    : { kind: "match", etag: expectedEtag };
}

export class WebDavResumeRepository {
  private readonly root: string;
  private readonly deviceId: string;
  private readonly createOperationId: () => string;

  constructor(
    private readonly client: WebDavClientApi,
    options: WebDavResumeRepositoryOptions,
  ) {
    this.root = normalizedRoot(options.remoteDirectory ?? DEFAULT_ROOT);
    assertSafeToken(options.deviceId);
    this.deviceId = options.deviceId;
    this.createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  }

  async ensureLayout(signal?: AbortSignal): Promise<void> {
    await this.client.ensureDirectory(this.root, signal);
    await this.client.ensureDirectory(`${this.root}${OBJECTS_DIRECTORY}`, signal);
    await this.client.ensureDirectory(`${this.root}${RESUMES_DIRECTORY}`, signal);
    await this.client.ensureDirectory(`${this.root}${TRASH_DIRECTORY}`, signal);
  }

  async ensureObjectDirectory(resumeId: string, signal?: AbortSignal): Promise<void> {
    assertSafeToken(resumeId);
    await this.client.ensureDirectory(`${this.root}${OBJECTS_DIRECTORY}${resumeId}/`, signal);
  }

  async readManifest(signal?: AbortSignal): Promise<RemoteTextFile | null> {
    return this.readFile(MANIFEST_FILE, signal);
  }

  async readResume(path: string, signal?: AbortSignal): Promise<RemoteTextFile | null> {
    assertResumePath(path);
    return this.readFile(path, signal);
  }

  async listResumeCandidates(signal?: AbortSignal): Promise<RemoteResumeCandidate[]> {
    const files = await this.client.listCollection(`${this.root}${RESUMES_DIRECTORY}`, signal);
    return files
      .filter(({ path }) =>
        !path.includes("/") && path.endsWith(".json") && !path.includes(".tmp-")
      )
      .map(({ path, etag }) => ({ path: `${RESUMES_DIRECTORY}${path}`, etag }));
  }

  async writeResumeAtomic(
    path: string,
    text: string,
    expectedEtag?: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    assertResumePath(path);
    parseResumeJson(text);
    await this.writeAtomic(path, text, preconditionFor(expectedEtag), signal);
  }

  async moveResumeAtomic(
    from: string,
    to: string,
    conditions: {
      sourceEtag: string | null;
      destinationPrecondition: RemotePrecondition;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    assertResumePath(from);
    assertResumePath(to);
    await this.client.move(
      `${this.root}${from}`,
      `${this.root}${to}`,
      conditions.destinationPrecondition,
      signal,
      conditions.sourceEtag ?? undefined,
    );
  }

  async deleteResumeAtomic(
    path: string,
    sourceEtag: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertResumePath(path);
    await this.client.delete(
      `${this.root}${path}`,
      { kind: "match", etag: sourceEtag },
      signal,
    );
  }

  async ensureManifestPublishSupported(signal?: AbortSignal): Promise<void> {
    const capabilities = await this.client.options(this.root, signal);
    if (!capabilities.conditionalMove) throw new WebDavError("MOVE_UNSUPPORTED");
  }

  async prepareManifestPublish(
    text: string,
    expectedEtag: string | null,
    signal?: AbortSignal,
  ): Promise<ManifestPublishOperation> {
    const sourcePath = this.temporaryPathFor(MANIFEST_FILE);
    try {
      await this.client.putText(sourcePath, text, { kind: "missing" }, signal);
      const source = await this.client.getTextWithMetadata(sourcePath, signal);
      if (!source?.etag || source.text !== text) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
      return {
        sourcePath,
        sourceEtag: source.etag,
        destinationPrecondition: preconditionFor(expectedEtag),
      };
    } catch (error) {
      try { await this.client.delete(sourcePath); } catch { /* best-effort prepare cleanup */ }
      throw error;
    }
  }

  async commitManifestPublish(operation: ManifestPublishOperation, signal?: AbortSignal): Promise<void> {
    await this.client.move(
      operation.sourcePath,
      `${this.root}${MANIFEST_FILE}`,
      operation.destinationPrecondition,
      signal,
      operation.sourceEtag,
    );
  }

  async cancelManifestPublish(operation: ManifestPublishOperation, signal?: AbortSignal): Promise<void> {
    await this.client.delete(
      operation.sourcePath,
      { kind: "match", etag: operation.sourceEtag },
      signal,
    );
  }

  async deleteManifest(expectedEtag: string, signal?: AbortSignal): Promise<void> {
    await this.client.delete(
      `${this.root}${MANIFEST_FILE}`,
      { kind: "match", etag: expectedEtag },
      signal,
    );
  }

  private async readFile(path: string, signal?: AbortSignal): Promise<RemoteTextFile | null> {
    const remote: RemoteText | null = await this.client.getTextWithMetadata(`${this.root}${path}`, signal);
    return remote === null ? null : { path, ...remote };
  }

  private temporaryPathFor(path: string): string {
    const operationId = this.createOperationId();
    assertSafeToken(operationId);
    return `${this.root}${path}.tmp-${this.deviceId}-${operationId}`;
  }

  private async writeAtomic(
    path: string,
    text: string,
    finalPrecondition: RemotePrecondition,
    signal?: AbortSignal,
  ): Promise<void> {
    const finalPath = `${this.root}${path}`;
    const temporaryPath = this.temporaryPathFor(path);
    try {
      await this.client.putText(temporaryPath, text, { kind: "missing" }, signal);
      await this.client.move(temporaryPath, finalPath, finalPrecondition, signal);
    } finally {
      try {
        await this.client.delete(temporaryPath);
      } catch {
        // Cleanup is best effort and must not replace the primary operation error.
      }
    }
  }
}
