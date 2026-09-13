import type { RemotePrecondition, WebDavClientApi } from "./client";
import { LocalCasMismatchError, WebDavError } from "./errors";
export { LocalCasMismatchError } from "./errors";
import {
  calculateContentHash,
  canonicalizeSyncData,
  createCloudSnapshot,
  parseCloudSnapshot,
} from "./snapshot";
import type { CloudSnapshotV1, ResumeSyncData, WebDavBaseline } from "./types";

export type SyncDecision = "upload" | "download" | "none" | "conflict";

export const decideSync = (
  localHash: string,
  cloud: Pick<CloudSnapshotV1, "revision" | "contentHash"> | null,
  baseline: WebDavBaseline | null,
): SyncDecision => {
  if (!cloud) return "upload";
  if (!baseline) return cloud.contentHash === localHash ? "none" : "conflict";
  const localChanged = localHash !== baseline.contentHash;
  const cloudChanged = cloud.revision !== baseline.revision;
  if (localChanged && cloudChanged) {
    return cloud.contentHash === localHash ? "none" : "conflict";
  }
  if (localChanged) return "upload";
  if (cloudChanged) return "download";
  return "none";
};

export interface CoordinatorDependencies {
  client: WebDavClientApi;
  getLocalData: () => ResumeSyncData;
  /** Compare the current local token and commit both values in one synchronous transaction. */
  commitDownloadedSnapshot: (
    data: ResumeSyncData,
    baseline: WebDavBaseline,
    expectedLocalToken: string,
  ) => void;
  getBaseline: () => WebDavBaseline | null;
  setBaseline: (baseline: WebDavBaseline) => void;
  deviceId: string;
  remoteDirectory: string;
  now: () => string;
  createRevision: () => string;
}

interface InspectedLocal {
  localData: ResumeSyncData;
  localHash: string;
  localToken: string;
}

export type SyncInspection = InspectedLocal & {
  remoteEtag: string | null;
} & (
  | { decision: "upload"; cloud: CloudSnapshotV1 | null }
  | { decision: "download"; cloud: CloudSnapshotV1 }
  | { decision: "none"; cloud: CloudSnapshotV1 | null }
  | {
      decision: "conflict";
      cloud: CloudSnapshotV1 | null;
      reason?: "LOCAL_CHANGED" | "LOCAL_CAS_MISMATCH" | "REMOTE_CAS_MISMATCH";
    }
);

export interface SyncExecutionResult {
  status: "uploaded" | "downloaded" | "unchanged";
  warning: "NON_ATOMIC_UPLOAD" | null;
}

export interface SyncDeferredResult {
  status: "deferred";
  warning: null;
  reason: "LOCAL_UNSTABLE" | "REMOTE_MISSING_AFTER_CAS";
}

export type SyncExecuteResult =
  | SyncExecutionResult
  | SyncDeferredResult
  | Extract<SyncInspection, { decision: "conflict" }>;

const withoutTrailingSlash = (path: string): string => path.replace(/\/+$/, "");

export class WebDavSyncCoordinator {
  private readonly directory: string;
  private readonly finalPath: string;

  constructor(private readonly dependencies: CoordinatorDependencies) {
    this.directory = `${withoutTrailingSlash(dependencies.remoteDirectory)}/`;
    this.finalPath = `${this.directory}magic-resume.json`;
  }

  async inspect(signal?: AbortSignal): Promise<SyncInspection> {
    const localData = this.dependencies.getLocalData();
    const localToken = canonicalizeSyncData(localData);
    const localHash = await calculateContentHash(localData);
    const remote = await this.dependencies.client.getTextWithMetadata(this.finalPath, signal);
    const cloud = remote === null ? null : await parseCloudSnapshot(remote.text);
    const remoteEtag = remote?.etag ?? null;
    const decision = decideSync(localHash, cloud, this.dependencies.getBaseline());

    if (decision === "download") {
      if (cloud === null) throw new Error("Cloud snapshot required");
      return { decision, cloud, remoteEtag, localData, localHash, localToken };
    }
    return { decision, cloud, remoteEtag, localData, localHash, localToken };
  }

  async execute(signal?: AbortSignal): Promise<SyncExecuteResult> {
    let inspection = await this.inspect(signal);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const currentLocalData = this.dependencies.getLocalData();
      const currentLocalToken = canonicalizeSyncData(currentLocalData);
      const currentLocalHash = await calculateContentHash(currentLocalData);
      const stableLocalToken = canonicalizeSyncData(this.dependencies.getLocalData());
      if (
        currentLocalToken !== inspection.localToken ||
        currentLocalHash !== inspection.localHash ||
        stableLocalToken !== currentLocalToken
      ) {
        if (attempt < 2) {
          inspection = await this.inspect(signal);
          continue;
        }
        const latestDecision = decideSync(
          currentLocalHash,
          inspection.cloud,
          this.dependencies.getBaseline(),
        );
        if (inspection.cloud && latestDecision === "conflict") {
          return {
            decision: "conflict",
            reason: "LOCAL_CHANGED",
            cloud: inspection.cloud,
            remoteEtag: inspection.remoteEtag,
            localData: currentLocalData,
            localHash: currentLocalHash,
            localToken: currentLocalToken,
          };
        }
        return {
          status: "deferred",
          warning: null,
          reason: "LOCAL_UNSTABLE",
        };
      }

      switch (inspection.decision) {
        case "upload":
          try {
            return await this.upload(
              inspection.localData,
              inspection.cloud?.revision ?? null,
              this.preconditionFor(inspection.cloud, inspection.remoteEtag),
              signal,
            );
          } catch (error) {
            if (!(error instanceof WebDavError) || error.code !== "REMOTE_CAS_MISMATCH") {
              throw error;
            }
            return this.refreshRemoteConflict(signal);
          }
        case "download":
          try {
            return this.commitCloud(inspection.cloud, currentLocalToken);
          } catch (error) {
            if (!(error instanceof LocalCasMismatchError)) throw error;
            return {
              decision: "conflict",
              reason: "LOCAL_CAS_MISMATCH",
              cloud: inspection.cloud,
              remoteEtag: inspection.remoteEtag,
              localData: currentLocalData,
              localHash: currentLocalHash,
              localToken: currentLocalToken,
            };
          }
        case "none":
          if (inspection.cloud) this.updateBaseline(inspection.cloud);
          return { status: "unchanged", warning: null };
        case "conflict":
          return inspection;
      }
    }
    throw new WebDavError("UNKNOWN");
  }

  async keepLocal(
    cloud: Pick<CloudSnapshotV1, "revision">,
    expectedEtagOrSignal?: string | null | AbortSignal,
    signal?: AbortSignal,
  ): Promise<SyncExecuteResult> {
    const expectedEtag = expectedEtagOrSignal instanceof AbortSignal
      ? undefined
      : expectedEtagOrSignal;
    const requestSignal = expectedEtagOrSignal instanceof AbortSignal
      ? expectedEtagOrSignal
      : signal;
    if (expectedEtag === undefined) throw new WebDavError("REMOTE_CAS_MISMATCH");
    const current = await this.inspect(requestSignal);
    if (
      current.cloud?.revision !== cloud.revision ||
      current.remoteEtag !== expectedEtag
    ) {
      return { ...current, decision: "conflict", reason: "REMOTE_CAS_MISMATCH" };
    }
    try {
      return await this.upload(
        this.dependencies.getLocalData(),
        cloud.revision,
        this.preconditionFor(current.cloud, current.remoteEtag),
        requestSignal,
      );
    } catch (error) {
      if (!(error instanceof WebDavError) || error.code !== "REMOTE_CAS_MISMATCH") {
        throw error;
      }
      return this.refreshRemoteConflict(requestSignal);
    }
  }

  async useCloud(
    cloud: CloudSnapshotV1,
    expectedEtagOrSignal?: string | null | AbortSignal,
    signal?: AbortSignal,
  ): Promise<SyncExecuteResult> {
    const expectedEtag = expectedEtagOrSignal instanceof AbortSignal
      ? undefined
      : expectedEtagOrSignal;
    const requestSignal = expectedEtagOrSignal instanceof AbortSignal
      ? expectedEtagOrSignal
      : signal;
    requestSignal?.throwIfAborted();
    if (expectedEtag === undefined) throw new WebDavError("REMOTE_CAS_MISMATCH");
    const current = await this.inspect(requestSignal);
    if (
      current.cloud?.revision !== cloud.revision ||
      current.remoteEtag !== expectedEtag
    ) {
      return { ...current, decision: "conflict", reason: "REMOTE_CAS_MISMATCH" };
    }
    const expectedLocalToken = canonicalizeSyncData(this.dependencies.getLocalData());
    const validated = await parseCloudSnapshot(JSON.stringify(cloud));
    requestSignal?.throwIfAborted();
    try {
      return this.commitCloud(validated, expectedLocalToken);
    } catch (error) {
      if (!(error instanceof LocalCasMismatchError)) throw error;
      const currentLocalData = this.dependencies.getLocalData();
      return {
        decision: "conflict",
        reason: "LOCAL_CAS_MISMATCH",
        cloud: validated,
        remoteEtag: current.remoteEtag,
        localData: currentLocalData,
        localHash: await calculateContentHash(currentLocalData),
        localToken: canonicalizeSyncData(currentLocalData),
      };
    }
  }

  private commitCloud(
    cloud: CloudSnapshotV1,
    expectedLocalToken: string,
  ): SyncExecutionResult {
    this.dependencies.commitDownloadedSnapshot(
      cloud.data,
      this.baselineFor(cloud),
      expectedLocalToken,
    );
    return { status: "downloaded", warning: null };
  }

  private async upload(
    localData: ResumeSyncData,
    parentRevision: string | null,
    precondition: RemotePrecondition,
    signal?: AbortSignal,
  ): Promise<SyncExecutionResult> {
    const revision = this.dependencies.createRevision();
    const snapshot = await createCloudSnapshot(localData, {
      revision,
      parentRevision,
      updatedAt: this.dependencies.now(),
      deviceId: this.dependencies.deviceId,
    });
    const content = JSON.stringify(snapshot);
    const temporaryPath = `${this.directory}magic-resume.${revision}.tmp`;
    let warning: SyncExecutionResult["warning"] = null;

    await this.dependencies.client.ensureDirectory(this.directory, signal);
    try {
      await this.dependencies.client.putText(temporaryPath, content, signal);
      try {
        await this.dependencies.client.move(
          temporaryPath,
          this.finalPath,
          precondition,
          signal,
        );
      } catch (error) {
        if (!(error instanceof WebDavError) || error.code !== "MOVE_UNSUPPORTED") throw error;
        await this.dependencies.client.putText(this.finalPath, content, precondition, signal);
        warning = "NON_ATOMIC_UPLOAD";
      }
    } finally {
      const cleanupController = new AbortController();
      const cleanupTimer = setTimeout(() => cleanupController.abort(), 2_000);
      try {
        await this.dependencies.client.delete(temporaryPath, cleanupController.signal);
      } catch {
        // Temporary-file cleanup is best effort and must not mask the transfer result.
      } finally {
        clearTimeout(cleanupTimer);
      }
    }

    this.updateBaseline(snapshot);
    return { status: "uploaded", warning };
  }

  private preconditionFor(
    cloud: CloudSnapshotV1 | null,
    remoteEtag: string | null,
  ): RemotePrecondition {
    if (!cloud) return { kind: "missing" };
    if (!remoteEtag) throw new WebDavError("REMOTE_CAS_MISMATCH");
    return { kind: "match", etag: remoteEtag };
  }

  private async refreshRemoteConflict(signal?: AbortSignal): Promise<SyncExecuteResult> {
    const latest = await this.inspect(signal);
    if (!latest.cloud) {
      return {
        status: "deferred",
        warning: null,
        reason: "REMOTE_MISSING_AFTER_CAS",
      };
    }
    return { ...latest, decision: "conflict", reason: "REMOTE_CAS_MISMATCH" };
  }

  private baselineFor(
    snapshot: Pick<CloudSnapshotV1, "revision" | "contentHash">,
  ): WebDavBaseline {
    return {
      revision: snapshot.revision,
      contentHash: snapshot.contentHash,
      syncedAt: this.dependencies.now(),
    };
  }

  private updateBaseline(snapshot: Pick<CloudSnapshotV1, "revision" | "contentHash">): void {
    this.dependencies.setBaseline(this.baselineFor(snapshot));
  }
}
