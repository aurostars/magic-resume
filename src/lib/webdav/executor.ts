import { LocalCasMismatchError, WebDavError } from "./errors";
import { createManifest, serializeManifest } from "./manifest";
import { calculateResumeHash, parseResumeJson, serializeResumeJson } from "./resume-codec";
import type { WebDavResumeRepository } from "./repository";
import type { ManifestV2, MultiFileBaseline, ResumeSyncConflict, ResumeSyncData, SyncPlan } from "./types";
import type { ResumeData } from "@/types/resume";

export type ExecutePlanResult =
  | { kind: "applied"; data: ResumeSyncData; baseline: MultiFileBaseline; syncedCount: number }
  | { kind: "conflict"; conflicts: ResumeSyncConflict[] }
  | { kind: "deferred"; reason: "local-changed" | "remote-changed" };

type RepositoryApi = Pick<WebDavResumeRepository,
  "ensureLayout" | "ensureObjectDirectory" | "readResume" | "writeResumeAtomic" |
  "moveResumeAtomic" | "publishManifest">;

export interface ExecuteSyncPlanInput {
  repository: RepositoryApi;
  plan: SyncPlan;
  localData: ResumeSyncData;
  remoteManifest: ManifestV2 | null;
  remoteManifestEtag: string | null;
  expectedLocalToken: string;
  getLocalToken: () => string;
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

async function publish(
  repository: RepositoryApi,
  manifest: ManifestV2,
  etag: string | null,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await repository.publishManifest(serializeManifest(manifest), etag, signal);
    return true;
  } catch (error) {
    if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") return false;
    throw error;
  }
}

async function repairMirror(
  repository: RepositoryApi,
  entry: ManifestV2["entries"][string],
  resume: ResumeData,
): Promise<void> {
  try {
    const current = await repository.readResume(entry.mirrorPath);
    if (current) {
      try {
        const parsed = parseResumeJson(current.text);
        if (await calculateResumeHash(parsed) === entry.contentHash) return;
      } catch { /* replace malformed mirror */ }
    }
    await repository.writeResumeAtomic(entry.mirrorPath, serializeResumeJson(resume), current?.etag ?? null);
    const verified = await verifiedResume(repository, entry.mirrorPath, entry.contentHash);
    if (!verified || verified.id !== resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  } catch {
    // Mirrors are repairable projections. Manifest + immutable object remain authoritative.
  }
}

export async function executeSyncPlan(input: ExecuteSyncPlanInput): Promise<ExecutePlanResult> {
  const { plan, repository } = input;
  if (plan.conflicts.length > 0) return { kind: "conflict", conflicts: plan.conflicts };
  if (input.getLocalToken() !== input.expectedLocalToken) {
    return { kind: "deferred", reason: "local-changed" };
  }

  const resumes = new Map(input.localData.resumes.map((resume) => [resume.id, resume]));
  const entries = structuredClone(input.remoteManifest?.entries ?? {});
  const objectResumes = new Map<string, ResumeData>();
  let remoteMutated = false;
  let syncedCount = 0;

  if (plan.uploads.length > 0 || (plan.manualImports?.length ?? 0) > 0 || plan.trashMoves.length > 0 || input.remoteManifest === null) {
    await repository.ensureLayout();
  }

  for (const imported of plan.manualImports ?? []) {
    const contentHash = await calculateResumeHash(imported.resume);
    const objectPath = objectPathFor(imported.resume.id, contentHash);
    await repository.ensureObjectDirectory(imported.resume.id);
    const existing = await repository.readResume(objectPath);
    if (!existing) {
      try {
        await repository.writeResumeAtomic(objectPath, serializeResumeJson(imported.resume), null);
      } catch (error) {
        if (!(error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH")) throw error;
      }
    }
    const confirmed = await verifiedResume(repository, objectPath, contentHash);
    if (!confirmed || confirmed.id !== imported.resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
    objectResumes.set(imported.resume.id, imported.resume);
  }

  for (const upload of plan.uploads) {
    const text = serializeResumeJson(upload.resume);
    const contentHash = await calculateResumeHash(upload.resume);
    const objectPath = objectPathFor(upload.resume.id, contentHash);
    await repository.ensureObjectDirectory(upload.resume.id);
    const existing = await repository.readResume(objectPath);
    if (!existing) {
      try {
        await repository.writeResumeAtomic(objectPath, text, null);
      } catch (error) {
        if (!(error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH")) throw error;
      }
    }
    const confirmed = await verifiedResume(repository, objectPath, contentHash);
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
    const object = await verifiedResume(repository, previous.objectPath, previous.contentHash);
    if (!object || object.id !== move.resumeId) return { kind: "deferred", reason: "remote-changed" };
    objectResumes.set(move.resumeId, object);
    entries[move.resumeId] = { ...previous, mirrorPath: move.to, updatedAt: input.now(), deleted: true };
    resumes.delete(move.resumeId);
    remoteMutated = true;
    syncedCount += 1;
  }

  for (const download of plan.downloads) {
    const downloaded = await verifiedResume(repository, download.objectPath, download.contentHash);
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
    if (input.getLocalToken() !== input.expectedLocalToken) {
      return { kind: "deferred", reason: "local-changed" };
    }
    finalManifest = await createManifest({
      schemaVersion: 2,
      revision: (input.remoteManifest?.revision ?? 0) + 1,
      parentRevision: input.remoteManifest?.revision ?? null,
      updatedAt: input.now(),
      deviceId: input.deviceId,
      activeResumeId: plan.nextActiveResumeId,
      entries,
    });
    if (!await publish(repository, finalManifest, input.remoteManifestEtag)) {
      return { kind: "deferred", reason: "remote-changed" };
    }
  }

  // Manifest publication is the commit point. Readable mirrors are updated only afterward.
  for (const upload of plan.uploads) {
    const entry = finalManifest.entries[upload.resume.id];
    if (upload.previousMirrorPath && upload.previousMirrorPath !== entry.mirrorPath) {
      try {
        const old = await repository.readResume(upload.previousMirrorPath);
        if (old) await repository.moveResumeAtomic(upload.previousMirrorPath, entry.mirrorPath, old.etag);
      } catch { /* mirror rename is repairable */ }
    }
    await repairMirror(repository, entry, upload.resume);
  }
  for (const move of plan.trashMoves) {
    const entry = finalManifest.entries[move.resumeId];
    const object = objectResumes.get(move.resumeId);
    try {
      const old = await repository.readResume(move.from);
      if (old) await repository.moveResumeAtomic(move.from, move.to, old.etag);
    } catch { /* trash mirror move is repairable */ }
    if (object) await repairMirror(repository, entry, object);
  }
  // Also heals missing/stale mirrors on a no-op sync.
  for (const [resumeId, entry] of Object.entries(finalManifest.entries)) {
    if (objectResumes.has(resumeId)) continue;
    const object = await verifiedResume(repository, entry.objectPath, entry.contentHash);
    if (object?.id === resumeId) await repairMirror(repository, entry, object);
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
