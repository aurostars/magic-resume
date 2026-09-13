import { executeSyncPlan } from "./executor";
import { WebDavError } from "./errors";
export { LocalCasMismatchError } from "./errors";
import { parseManifest } from "./manifest";
import { planSync } from "./planner";
import {
  calculateResumeHash,
  getResumeRelativePath,
  parseResumeJson,
} from "./resume-codec";
import type { WebDavResumeRepository } from "./repository";
import { canonicalizeSyncData } from "./snapshot";
import type {
  ManifestV2,
  MultiFileBaseline,
  CloudSnapshotV1,
  ResumeSyncConflict,
  ResumeSyncData,
  SyncPlan,
} from "./types";

export type ConflictDecision = {
  resumeId: string;
  resolution: "keep-local" | "use-cloud";
  seenRemoteEtag: string | null;
  seenManifestRevision: number;
};

export interface CoordinatorDependencies {
  repository: Pick<WebDavResumeRepository,
    "ensureLayout" | "ensureObjectDirectory" | "readManifest" | "readResume" | "listResumeCandidates" |
    "writeResumeAtomic" | "moveResumeAtomic" | "ensureManifestPublishSupported" |
    "prepareManifestPublish" | "commitManifestPublish" | "cancelManifestPublish" | "deleteManifest">;
  getLocalData: () => ResumeSyncData;
  subscribeLocalData: (listener: () => void) => () => void;
  getBaseline: () => MultiFileBaseline | null;
  commit: (
    data: ResumeSyncData,
    baseline: MultiFileBaseline,
    expectedLocalToken: string,
  ) => void;
  deviceId: string;
  now: () => string;
}

export interface SyncWarning {
  code: "INVALID_REMOTE_RESUME" | "AMBIGUOUS_REMOTE_RESUME";
}

interface SyncInspectionBase {
  localData: ResumeSyncData;
  localToken: string;
  localHashes: Record<string, string>;
  manifest: ManifestV2 | null;
  persistedManifest: ManifestV2 | null;
  remoteEtag: string | null;
  plan: SyncPlan;
  conflicts: ResumeSyncConflict[];
  warnings: SyncWarning[];
  discoveredRemoteFiles: boolean;
}

export type SyncInspection = SyncInspectionBase & (
  | { decision: "upload" | "download" | "none" }
  | { decision: "conflict" }
);

export type SyncExecutionResult = {
  status: "uploaded" | "downloaded" | "unchanged";
  warning: null;
  syncedCount: number;
};
export type SyncDeferredResult = {
  status: "deferred";
  warning: null;
  reason: "LOCAL_CHANGED" | "REMOTE_CHANGED" | "REMOTE_UNCERTAIN";
};
export type SyncConflictResult = SyncInspection & { decision: "conflict" };
export type SyncExecuteResult = SyncExecutionResult | SyncDeferredResult | SyncConflictResult;

const compareIds = (left: string, right: string): number => left.localeCompare(right);

function decisionFor(plan: SyncPlan): SyncInspection["decision"] {
  if (plan.conflicts.length > 0) return "conflict";
  if (plan.uploads.length > 0 || plan.trashMoves.length > 0) return "upload";
  if (plan.downloads.length > 0 || plan.remoteDeletions.length > 0) return "download";
  return "none";
}

async function localHashes(data: ResumeSyncData): Promise<Record<string, string>> {
  const pairs = await Promise.all(data.resumes.map(async (resume) => [
    resume.id,
    await calculateResumeHash(resume),
  ] as const));
  return Object.fromEntries(pairs);
}

export class WebDavSyncCoordinator {
  constructor(private readonly dependencies: CoordinatorDependencies) {}

  async inspect(signal?: AbortSignal): Promise<SyncInspection> {
    const localData = this.dependencies.getLocalData();
    const localToken = canonicalizeSyncData(localData);
    const hashes = await localHashes(localData);
    const remoteFile = await this.dependencies.repository.readManifest(signal);
    const persistedManifest = remoteFile ? await parseManifest(remoteFile.text) : null;
    let manifest = persistedManifest;
    const warnings: SyncWarning[] = [];
    const manualImports: NonNullable<SyncPlan["manualImports"]> = [];
    let discoveredRemoteFiles = false;

    if (manifest) {
      const entries = structuredClone(manifest.entries);
      const indexedPaths = new Set(Object.values(entries).map((entry) => entry.mirrorPath));
      const discovered = new Map<string, Array<{
        resume: ResumeSyncData["resumes"][number];
        mirrorPath: string;
        contentHash: string;
      }>>();
      const candidates = await this.dependencies.repository.listResumeCandidates(signal);
      for (const candidate of [...candidates].sort((a, b) => a.path.localeCompare(b.path))) {
        if (indexedPaths.has(candidate.path)) continue;
        const file = await this.dependencies.repository.readResume(candidate.path, signal);
        if (!file) continue;
        try {
          const resume = parseResumeJson(file.text);
          const contentHash = await calculateResumeHash(resume);
          const values = discovered.get(resume.id) ?? [];
          values.push({ resume, mirrorPath: candidate.path, contentHash });
          discovered.set(resume.id, values);
        } catch {
          warnings.push({ code: "INVALID_REMOTE_RESUME" });
        }
      }
      for (const [resumeId, values] of Array.from(discovered.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        const hashes = new Set(values.map((value) => value.contentHash));
        if (hashes.size > 1) {
          warnings.push({ code: "AMBIGUOUS_REMOTE_RESUME" });
          continue;
        }
        const selected = values[0];
        const existing = entries[resumeId];
        if (existing?.contentHash === selected.contentHash) continue;
        entries[resumeId] = {
          objectPath: `objects/${resumeId}/${selected.contentHash}.json`,
          mirrorPath: selected.mirrorPath,
          contentHash: selected.contentHash,
          updatedAt: selected.resume.updatedAt,
          deleted: false,
        };
        manualImports.push({ resume: selected.resume, mirrorPath: selected.mirrorPath });
        discoveredRemoteFiles = true;
      }
      if (discoveredRemoteFiles) manifest = { ...manifest, entries };
    }

    const plan = planSync({
      local: localData,
      localHashes: hashes,
      remote: manifest,
      baseline: this.dependencies.getBaseline(),
    });
    plan.manualImports = manualImports;
    return {
      decision: decisionFor(plan),
      localData,
      localToken,
      localHashes: hashes,
      manifest,
      persistedManifest,
      remoteEtag: remoteFile?.etag ?? null,
      plan,
      conflicts: plan.conflicts,
      warnings,
      discoveredRemoteFiles,
    };
  }

  async execute(
    decisionOrSignal?: ConflictDecision | AbortSignal,
    signal?: AbortSignal,
  ): Promise<SyncExecuteResult> {
    const decision = decisionOrSignal instanceof AbortSignal ? undefined : decisionOrSignal;
    const requestSignal = decisionOrSignal instanceof AbortSignal ? decisionOrSignal : signal;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      requestSignal?.throwIfAborted();
      const inspection = await this.inspect(requestSignal);
      if (decision && (
        !Object.prototype.hasOwnProperty.call(decision, "seenRemoteEtag") ||
        !Object.prototype.hasOwnProperty.call(decision, "seenManifestRevision") ||
        decision.seenRemoteEtag !== inspection.remoteEtag ||
        decision.seenManifestRevision !== inspection.manifest?.revision
      )) {
        return { status: "deferred", warning: null, reason: "REMOTE_CHANGED" };
      }
      const plan = decision ? this.resolve(inspection.plan, decision) : inspection.plan;
      if (plan.conflicts.length > 0) {
        return { ...inspection, decision: "conflict", plan, conflicts: plan.conflicts };
      }
      const intendedStatus = plan.uploads.length > 0 || plan.trashMoves.length > 0 ||
          inspection.manifest === null || inspection.discoveredRemoteFiles
        ? "uploaded"
        : plan.downloads.length > 0 || plan.remoteDeletions.length > 0
        ? "downloaded"
        : "unchanged";
      const result = await executeSyncPlan({
        repository: this.dependencies.repository,
        plan,
        localData: inspection.localData,
        remoteManifest: inspection.manifest,
        previousManifest: inspection.persistedManifest,
        remoteManifestEtag: inspection.remoteEtag,
        expectedLocalToken: inspection.localToken,
        getLocalToken: () => canonicalizeSyncData(this.dependencies.getLocalData()),
        subscribeLocalToken: this.dependencies.subscribeLocalData,
        deviceId: this.dependencies.deviceId,
        now: this.dependencies.now,
        commit: this.dependencies.commit,
        forceManifestPublish: inspection.discoveredRemoteFiles,
        signal: requestSignal,
      });
      if (result.kind === "conflict") {
        return { ...inspection, decision: "conflict", plan, conflicts: result.conflicts };
      }
      if (result.kind === "deferred") {
        if (attempt < 2) continue;
        return {
          status: "deferred",
          warning: null,
          reason: result.reason === "local-changed"
            ? "LOCAL_CHANGED"
            : result.reason === "remote-uncertain"
            ? "REMOTE_UNCERTAIN"
            : "REMOTE_CHANGED",
        };
      }
      return {
        status: intendedStatus,
        warning: null,
        syncedCount: result.syncedCount,
      };
    }
    throw new WebDavError("UNKNOWN");
  }

  /** Compatibility bridge for the current controller; Task 7 replaces its aggregate dialog model. */
  keepLocal(
    cloud: Pick<CloudSnapshotV1, "revision">,
    expectedEtag: string | null,
    seenManifestRevision: number,
    signal?: AbortSignal,
  ): Promise<SyncExecuteResult> {
    return this.execute({
      resumeId: cloud.revision,
      resolution: "keep-local",
      seenRemoteEtag: expectedEtag,
      seenManifestRevision,
    }, signal);
  }

  /** Compatibility bridge for the current controller; Task 7 replaces its aggregate dialog model. */
  useCloud(
    cloud: Pick<CloudSnapshotV1, "revision">,
    expectedEtag: string | null,
    seenManifestRevision: number,
    signal?: AbortSignal,
  ): Promise<SyncExecuteResult> {
    return this.execute({
      resumeId: cloud.revision,
      resolution: "use-cloud",
      seenRemoteEtag: expectedEtag,
      seenManifestRevision,
    }, signal);
  }

  private resolve(plan: SyncPlan, decision: ConflictDecision): SyncPlan {
    const conflict = plan.conflicts.find((item) => item.resumeId === decision.resumeId);
    if (!conflict) return plan;
    const next: SyncPlan = {
      ...plan,
      uploads: [...plan.uploads],
      downloads: [...plan.downloads],
      trashMoves: [...plan.trashMoves],
      remoteDeletions: [...plan.remoteDeletions],
      conflicts: plan.conflicts.filter((item) => item !== conflict),
    };
    if (decision.resolution === "keep-local") {
      if (conflict.local) {
        const mirrorPath = getResumeRelativePath(conflict.local);
        next.uploads.push({
          resume: conflict.local,
          mirrorPath,
          previousMirrorPath: conflict.remoteEntry && !conflict.remoteEntry.deleted &&
              conflict.remoteEntry.mirrorPath !== mirrorPath
            ? conflict.remoteEntry.mirrorPath
            : null,
        });
      } else if (conflict.remoteEntry && !conflict.remoteEntry.deleted) {
        next.trashMoves.push({
          resumeId: conflict.resumeId,
          from: conflict.remoteEntry.mirrorPath,
          to: `trash/${conflict.remoteEntry.mirrorPath.split("/").at(-1)}`,
        });
      }
    } else if (!conflict.remoteEntry || conflict.remoteEntry.deleted) {
      next.remoteDeletions.push(conflict.resumeId);
    } else {
      next.downloads.push({
        resumeId: conflict.resumeId,
        objectPath: conflict.remoteEntry.objectPath,
        contentHash: conflict.remoteEntry.contentHash,
      });
    }
    next.uploads.sort((a, b) => compareIds(a.resume.id, b.resume.id));
    next.downloads.sort((a, b) => compareIds(a.resumeId, b.resumeId));
    return next;
  }
}
