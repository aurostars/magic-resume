import { LocalCasMismatchError, WebDavError } from "./errors";
import { createManifest, parseManifest, serializeManifest } from "./manifest";
import { calculateResumeHash, parseResumeJson, serializeResumeJson } from "./resume-codec";
import type { ManifestPublishOperation, WebDavResumeRepository } from "./repository";
import type { ManifestV2, MultiFileBaseline, ResumeSyncConflict, ResumeSyncData, SyncPlan } from "./types";
import type { ResumeData } from "@/types/resume";

export type ExecutePlanResult =
  | { kind: "applied"; data: ResumeSyncData; baseline: MultiFileBaseline; syncedCount: number }
  | { kind: "conflict"; conflicts: ResumeSyncConflict[] }
  | { kind: "deferred"; reason: "local-changed" | "remote-changed" | "remote-uncertain" };

type RepositoryApi = Pick<WebDavResumeRepository,
  "ensureLayout" | "ensureObjectDirectory" | "readManifest" | "readResume" | "writeResumeAtomic" |
  "moveResumeAtomic" | "deleteResumeAtomic" | "ensureManifestPublishSupported" | "prepareManifestPublish" |
  "commitManifestPublish" | "cancelManifestPublish" | "deleteManifest">;

export interface ExecuteSyncPlanInput {
  repository: RepositoryApi;
  plan: SyncPlan;
  localData: ResumeSyncData;
  remoteManifest: ManifestV2 | null;
  previousManifest: ManifestV2 | null;
  remoteManifestEtag: string | null;
  currentBaseline: MultiFileBaseline | null;
  expectedLocalToken: string;
  getLocalToken: () => string;
  subscribeLocalToken: (listener: () => void) => () => void;
  deviceId: string;
  now: () => string;
  forceManifestPublish?: boolean;
  signal?: AbortSignal;
  commit: (data: ResumeSyncData, baseline: MultiFileBaseline, expectedLocalToken: string) => void;
}

const objectPathFor = (id: string, hash: string): string => `objects/${id}/${hash}.json`;
const baselineFor = (manifest: ManifestV2): MultiFileBaseline => ({
  manifestRevision: manifest.revision,
  manifestHash: manifest.manifestHash,
  activeResumeId: manifest.activeResumeId,
  entries: Object.fromEntries(Object.entries(manifest.entries).map(([id, entry]) => [id, {
    contentHash: entry.contentHash,
    deleted: entry.deleted,
    objectPath: entry.objectPath,
    mirrorPath: entry.mirrorPath,
  }])),
});

const baselineEquivalent = (
  current: MultiFileBaseline | null | undefined,
  next: MultiFileBaseline,
): boolean => current !== null && current !== undefined &&
  current.manifestRevision === next.manifestRevision &&
  current.manifestHash === next.manifestHash &&
  current.activeResumeId === next.activeResumeId;

async function verifiedResume(
  repository: RepositoryApi,
  path: string,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<ResumeData | null> {
  const file = await repository.readResume(path, signal);
  if (!file) return null;
  let resume: ResumeData;
  try { resume = parseResumeJson(file.text); } catch { throw new WebDavError("REMOTE_CONTENT_MISMATCH"); }
  if (await calculateResumeHash(resume) !== expectedHash) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  return resume;
}

async function validateManifestObjects(
  repository: RepositoryApi,
  manifest: ManifestV2,
  signal?: AbortSignal,
): Promise<"valid" | "missing"> {
  for (const [resumeId, entry] of Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.deleted) continue;
    const resume = await verifiedResume(repository, entry.objectPath, entry.contentHash, signal);
    if (!resume) return "missing";
    if (resume.id !== resumeId) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  }
  return "valid";
}

async function repairMirror(
  repository: RepositoryApi,
  entry: ManifestV2["entries"][string],
  resume: ResumeData,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const current = await repository.readResume(entry.mirrorPath, signal);
    if (current) {
      try {
        const parsed = parseResumeJson(current.text);
        if (await calculateResumeHash(parsed) === entry.contentHash) return;
      } catch { /* replace malformed mirror */ }
    }
    await repository.writeResumeAtomic(
      entry.mirrorPath,
      serializeResumeJson(resume),
      current?.etag ?? null,
      signal,
    );
    const verified = await verifiedResume(repository, entry.mirrorPath, entry.contentHash, signal);
    if (!verified || verified.id !== resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    // Mirrors are repairable projections. Manifest + immutable object remain authoritative.
  }
}

type PreparedManifestCommitResult =
  | "committed"
  | "not-committed"
  | "remote-changed"
  | "remote-uncertain";

type ExpectedDestinationState = {
  before: ManifestV2 | null;
  after: ManifestV2;
};

function isSourceMissing(error: unknown): boolean {
  return error instanceof WebDavError &&
    (error.code === "NOT_FOUND" || error.status === 404);
}

function isUncertainCommitError(error: unknown): boolean {
  return error instanceof WebDavError &&
    (error.code === "NETWORK" || error.code === "TIMEOUT");
}

async function classifyDestination(
  input: ExecuteSyncPlanInput,
  expected: ExpectedDestinationState,
): Promise<PreparedManifestCommitResult> {
  const latestFile = await input.repository.readManifest();
  if (!latestFile) return "remote-uncertain";
  const latest = await parseManifest(latestFile.text);
  if (latest.manifestHash === expected.after.manifestHash) return "committed";
  if (expected.before && latest.manifestHash === expected.before.manifestHash) {
    return "remote-uncertain";
  }
  return "remote-changed";
}

async function commitPreparedManifestWithReconciliation(
  input: ExecuteSyncPlanInput,
  operation: ManifestPublishOperation,
  expected: ExpectedDestinationState,
  commitSignal: AbortSignal,
): Promise<PreparedManifestCommitResult> {
  try {
    await input.repository.commitManifestPublish(operation, commitSignal);
    return "committed";
  } catch (commitError) {
    if (!isUncertainCommitError(commitError)) {
      try { await input.repository.cancelManifestPublish(operation); } catch { /* orphan temp only */ }
      if (commitError instanceof WebDavError && commitError.code === "REMOTE_CAS_MISMATCH") {
        return "remote-changed";
      }
      throw commitError;
    }

    try {
      await input.repository.cancelManifestPublish(operation);
      return "not-committed";
    } catch (cancelError) {
      if (isSourceMissing(cancelError)) return classifyDestination(input, expected);
      // 412/423 does not prove the source disappeared; a delayed MOVE may still consume it.
      return "remote-uncertain";
    }
  }
}

async function restoreAttemptedManifest(
  input: ExecuteSyncPlanInput,
  attempted: ManifestV2,
  attemptedEtag: string,
): Promise<PreparedManifestCommitResult> {
  if (!input.previousManifest) {
    try {
      await input.repository.deleteManifest(attemptedEtag);
      return "committed";
    } catch (error) {
      if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") {
        return "remote-changed";
      }
      throw error;
    }
  }

  const restore = await input.repository.prepareManifestPublish(
    serializeManifest(input.previousManifest),
    attemptedEtag,
  );
  return commitPreparedManifestWithReconciliation(
    input,
    restore,
    { before: attempted, after: input.previousManifest },
    new AbortController().signal,
  );
}

async function reconcileKnownSuccessfulMove(
  input: ExecuteSyncPlanInput,
  attempted: ManifestV2,
): Promise<PreparedManifestCommitResult> {
  const latestFile = await input.repository.readManifest();
  if (!latestFile) return "remote-uncertain";
  const latest = await parseManifest(latestFile.text);
  if (latest.manifestHash !== attempted.manifestHash) return "remote-changed";
  if (!latestFile.etag) return "remote-uncertain";
  return restoreAttemptedManifest(input, attempted, latestFile.etag);
}

export async function executeSyncPlan(input: ExecuteSyncPlanInput): Promise<ExecutePlanResult> {
  const { plan, repository, signal } = input;
  if (plan.conflicts.length > 0) return { kind: "conflict", conflicts: plan.conflicts };
  if (input.getLocalToken() !== input.expectedLocalToken) {
    return { kind: "deferred", reason: "local-changed" };
  }
  signal?.throwIfAborted();

  const resumes = new Map(input.localData.resumes.map((resume) => [resume.id, resume]));
  const entries = structuredClone(input.remoteManifest?.entries ?? {});
  const objectResumes = new Map<string, ResumeData>();
  let remoteMutated = false;
  let syncedCount = 0;

  if (plan.uploads.length > 0 || (plan.manualImports?.length ?? 0) > 0 || plan.trashMoves.length > 0 || input.remoteManifest === null) {
    await repository.ensureLayout(signal);
  }

  for (const imported of plan.manualImports ?? []) {
    const contentHash = await calculateResumeHash(imported.resume);
    const objectPath = objectPathFor(imported.resume.id, contentHash);
    await repository.ensureObjectDirectory(imported.resume.id, signal);
    const existing = await repository.readResume(objectPath, signal);
    if (!existing) {
      try {
        await repository.writeResumeAtomic(objectPath, serializeResumeJson(imported.resume), null, signal);
      } catch (error) {
        if (!(error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH")) throw error;
      }
    }
    const confirmed = await verifiedResume(repository, objectPath, contentHash, signal);
    if (!confirmed || confirmed.id !== imported.resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
    objectResumes.set(imported.resume.id, imported.resume);
  }

  for (const upload of plan.uploads) {
    const text = serializeResumeJson(upload.resume);
    const contentHash = await calculateResumeHash(upload.resume);
    const objectPath = objectPathFor(upload.resume.id, contentHash);
    await repository.ensureObjectDirectory(upload.resume.id, signal);
    const existing = await repository.readResume(objectPath, signal);
    if (!existing) {
      try {
        await repository.writeResumeAtomic(objectPath, text, null, signal);
      } catch (error) {
        if (!(error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH")) throw error;
      }
    }
    const confirmed = await verifiedResume(repository, objectPath, contentHash, signal);
    if (!confirmed || confirmed.id !== upload.resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
    objectResumes.set(upload.resume.id, upload.resume);
    entries[upload.resume.id] = {
      objectPath,
      mirrorPath: upload.mirrorPath,
      contentHash,
      updatedAt: input.now(),
      deleted: false,
    };
    remoteMutated = true;
    syncedCount += 1;
  }

  for (const move of plan.trashMoves) {
    const previous = entries[move.resumeId];
    if (!previous) return { kind: "deferred", reason: "remote-changed" };
    const object = await verifiedResume(repository, previous.objectPath, previous.contentHash, signal);
    if (!object || object.id !== move.resumeId) return { kind: "deferred", reason: "remote-changed" };
    objectResumes.set(move.resumeId, object);
    entries[move.resumeId] = { ...previous, mirrorPath: move.to, updatedAt: input.now(), deleted: true };
    resumes.delete(move.resumeId);
    remoteMutated = true;
    syncedCount += 1;
  }

  for (const download of plan.downloads) {
    const downloaded = await verifiedResume(repository, download.objectPath, download.contentHash, signal);
    if (!downloaded || downloaded.id !== download.resumeId) return { kind: "deferred", reason: "remote-changed" };
    objectResumes.set(download.resumeId, downloaded);
    resumes.set(download.resumeId, downloaded);
    syncedCount += 1;
  }
  for (const resumeId of plan.remoteDeletions) {
    resumes.delete(resumeId);
    syncedCount += 1;
  }

  let finalManifest = input.remoteManifest;
  if (remoteMutated || finalManifest === null || input.forceManifestPublish || plan.activeResumeChange === "upload") {
    finalManifest = await createManifest({
      schemaVersion: 2,
      revision: (input.remoteManifest?.revision ?? 0) + 1,
      parentRevision: input.remoteManifest?.revision ?? null,
      updatedAt: input.now(),
      deviceId: input.deviceId,
      activeResumeId: plan.nextActiveResumeId,
      entries,
    });
    if (await validateManifestObjects(repository, finalManifest, signal) === "missing") {
      return { kind: "deferred", reason: "remote-changed" };
    }

    let localChanged = false;
    let publication: ManifestPublishOperation | null = null;
    const observeLocal = () => {
      if (input.getLocalToken() !== input.expectedLocalToken) localChanged = true;
    };
    const unsubscribe = input.subscribeLocalToken(observeLocal);
    try {
      observeLocal();
      if (localChanged) return { kind: "deferred", reason: "local-changed" };
      signal?.throwIfAborted();

      await repository.ensureManifestPublishSupported(signal);
      observeLocal();
      if (localChanged) return { kind: "deferred", reason: "local-changed" };
      signal?.throwIfAborted();

      publication = await repository.prepareManifestPublish(
        serializeManifest(finalManifest),
        input.remoteManifestEtag,
        signal,
      );
      observeLocal();
      if (localChanged) {
        try { await repository.cancelManifestPublish(publication); } catch { /* orphan temp only */ }
        publication = null;
        return { kind: "deferred", reason: "local-changed" };
      }
      if (signal?.aborted) {
        const abortReason = signal.reason;
        try { await repository.cancelManifestPublish(publication); } catch { /* preserve abort */ }
        publication = null;
        throw abortReason;
      }

      // Once issued, MOVE is deliberately detached from cancellation. Both initial publication and
      // restoration use the same temp-source arbitration for uncertain network outcomes.
      const commitResult = await commitPreparedManifestWithReconciliation(
        input,
        publication,
        { before: input.previousManifest, after: finalManifest },
        new AbortController().signal,
      );
      publication = null;
      observeLocal();

      if (commitResult === "not-committed") {
        return {
          kind: "deferred",
          reason: localChanged ? "local-changed" : "remote-changed",
        };
      }
      if (commitResult === "remote-changed" || commitResult === "remote-uncertain") {
        return { kind: "deferred", reason: commitResult };
      }
      if (localChanged) {
        const recovery = await reconcileKnownSuccessfulMove(input, finalManifest);
        if (recovery === "committed") {
          return { kind: "deferred", reason: "local-changed" };
        }
        return {
          kind: "deferred",
          reason: recovery === "remote-changed" ? "remote-changed" : "remote-uncertain",
        };
      }
    } finally {
      unsubscribe();
      if (publication) {
        try { await repository.cancelManifestPublish(publication); } catch { /* preserve primary outcome */ }
      }
    }
  }

  // Manifest publication is the commit point. Readable mirrors are updated only afterward.
  for (const upload of plan.uploads) {
    const entry = finalManifest.entries[upload.resume.id];
    if (upload.previousMirrorPath && upload.previousMirrorPath !== entry.mirrorPath) {
      try {
        const old = await repository.readResume(upload.previousMirrorPath, signal);
        if (old) await repository.moveResumeAtomic(upload.previousMirrorPath, entry.mirrorPath, {
          sourceEtag: old.etag,
          destinationPrecondition: { kind: "missing" },
        }, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
      }
    }
    await repairMirror(repository, entry, upload.resume, signal);
  }
  for (const move of plan.trashMoves) {
    const entry = finalManifest.entries[move.resumeId];
    const object = objectResumes.get(move.resumeId);
    try {
      const old = await repository.readResume(move.from, signal);
      if (old) await repository.moveResumeAtomic(move.from, move.to, {
        sourceEtag: old.etag,
        destinationPrecondition: { kind: "missing" },
      }, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
    }
    if (object) await repairMirror(repository, entry, object, signal);
  }
  // Also heals missing/stale mirrors on a no-op sync.
  for (const [resumeId, entry] of Object.entries(finalManifest.entries)) {
    if (objectResumes.has(resumeId)) continue;
    const object = await verifiedResume(repository, entry.objectPath, entry.contentHash, signal);
    if (object?.id === resumeId) await repairMirror(repository, entry, object, signal);
  }

  const data: ResumeSyncData = {
    resumes: Array.from(resumes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    activeResumeId: plan.nextActiveResumeId,
  };
  const baseline = baselineFor(finalManifest);
  if (syncedCount === 0 && baselineEquivalent(input.currentBaseline, baseline)) {
    return { kind: "applied", data, baseline, syncedCount };
  }
  try {
    input.commit(data, baseline, input.expectedLocalToken);
  } catch (error) {
    if (error instanceof LocalCasMismatchError) return { kind: "deferred", reason: "local-changed" };
    throw error;
  }
  return { kind: "applied", data, baseline, syncedCount };
}
