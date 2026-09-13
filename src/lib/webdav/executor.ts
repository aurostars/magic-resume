import { LocalCasMismatchError, WebDavError } from "./errors";
import { createManifest, parseManifest, serializeManifest } from "./manifest";
import { calculateResumeHash, parseResumeJson, serializeResumeJson } from "./resume-codec";
import type { WebDavResumeRepository } from "./repository";
import type { ManifestV2, MultiFileBaseline, ResumeSyncConflict, ResumeSyncData, SyncPlan } from "./types";
import type { ResumeData } from "@/types/resume";

export type ExecutePlanResult =
  | { kind: "applied"; data: ResumeSyncData; baseline: MultiFileBaseline; syncedCount: number }
  | { kind: "conflict"; conflicts: ResumeSyncConflict[] }
  | { kind: "deferred"; reason: "local-changed" | "remote-changed" };

type RepositoryApi = Pick<WebDavResumeRepository,
  "ensureLayout" | "ensureObjectDirectory" | "readManifest" | "readResume" | "writeResumeAtomic" |
  "moveResumeAtomic" | "publishManifest" | "deleteManifest">;

export interface ExecuteSyncPlanInput {
  repository: RepositoryApi;
  plan: SyncPlan;
  localData: ResumeSyncData;
  remoteManifest: ManifestV2 | null;
  previousManifest: ManifestV2 | null;
  remoteManifestEtag: string | null;
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

function linkedController(external?: AbortSignal): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });
  return {
    controller,
    dispose: () => external?.removeEventListener("abort", abort),
  };
}

async function reconcileLocalRace(
  input: ExecuteSyncPlanInput,
  attempted: ManifestV2,
): Promise<boolean> {
  try {
    const latestFile = await input.repository.readManifest(input.signal);
    if (!latestFile) return true;
    const latest = await parseManifest(latestFile.text);
    if (latest.manifestHash !== attempted.manifestHash) {
      return input.previousManifest !== null && latest.manifestHash === input.previousManifest.manifestHash;
    }
    if (!latestFile.etag) return false;
    if (input.previousManifest) {
      await input.repository.publishManifest(
        serializeManifest(input.previousManifest),
        latestFile.etag,
        input.signal,
      );
    } else {
      await input.repository.deleteManifest(latestFile.etag, input.signal);
    }
    return true;
  } catch {
    return false;
  }
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
  if (remoteMutated || finalManifest === null || input.forceManifestPublish) {
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
    const linked = linkedController(signal);
    const observeLocal = () => {
      if (input.getLocalToken() !== input.expectedLocalToken) {
        localChanged = true;
        linked.controller.abort(new LocalCasMismatchError());
      }
    };
    const unsubscribe = input.subscribeLocalToken(observeLocal);
    observeLocal();
    if (localChanged) {
      unsubscribe();
      linked.dispose();
      return { kind: "deferred", reason: "local-changed" };
    }

    let publishError: unknown = null;
    try {
      await repository.publishManifest(
        serializeManifest(finalManifest),
        input.remoteManifestEtag,
        linked.controller.signal,
      );
    } catch (error) {
      publishError = error;
    } finally {
      observeLocal();
      unsubscribe();
      linked.dispose();
    }
    if (localChanged) {
      await reconcileLocalRace(input, finalManifest);
      return { kind: "deferred", reason: "local-changed" };
    }
    if (publishError) {
      if (publishError instanceof WebDavError && publishError.code === "REMOTE_CAS_MISMATCH") {
        return { kind: "deferred", reason: "remote-changed" };
      }
      throw publishError;
    }
  }

  // Manifest publication is the commit point. Readable mirrors are updated only afterward.
  for (const upload of plan.uploads) {
    const entry = finalManifest.entries[upload.resume.id];
    if (upload.previousMirrorPath && upload.previousMirrorPath !== entry.mirrorPath) {
      try {
        const old = await repository.readResume(upload.previousMirrorPath, signal);
        if (old) await repository.moveResumeAtomic(upload.previousMirrorPath, entry.mirrorPath, old.etag, signal);
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
      if (old) await repository.moveResumeAtomic(move.from, move.to, old.etag, signal);
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
  if (syncedCount === 0 && !remoteMutated && !input.forceManifestPublish) {
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
