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
  "ensureLayout" | "readResume" | "writeResumeAtomic" | "moveResumeAtomic" | "publishManifest">;

export interface ExecuteSyncPlanInput {
  repository: RepositoryApi;
  plan: SyncPlan;
  localData: ResumeSyncData;
  remoteManifest: ManifestV2 | null;
  remoteManifestEtag: string | null;
  expectedLocalToken: string;
  deviceId: string;
  now: () => string;
  forceManifestPublish?: boolean;
  commit: (data: ResumeSyncData, baseline: MultiFileBaseline, expectedLocalToken: string) => void;
}

const trashPath = (path: string): string => `trash/${path.split("/").at(-1) ?? path}`;
const baselineFor = (manifest: ManifestV2): MultiFileBaseline => ({
  manifestRevision: manifest.revision,
  manifestHash: manifest.manifestHash,
  activeResumeId: manifest.activeResumeId,
  entries: Object.fromEntries(Object.entries(manifest.entries).map(([id, entry]) => [id, {
    contentHash: entry.contentHash, deleted: entry.deleted, path: entry.path,
  }])),
});

async function verifiedResume(repository: RepositoryApi, path: string, expectedHash: string): Promise<ResumeData | null> {
  const file = await repository.readResume(path);
  if (!file) return null;
  let resume: ResumeData;
  try {
    resume = parseResumeJson(file.text);
  } catch {
    throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  }
  if (await calculateResumeHash(resume) !== expectedHash) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
  return resume;
}

export async function executeSyncPlan(input: ExecuteSyncPlanInput): Promise<ExecutePlanResult> {
  const { plan, repository } = input;
  if (plan.conflicts.length > 0) return { kind: "conflict", conflicts: plan.conflicts };

  const resumes = new Map(input.localData.resumes.map((resume) => [resume.id, resume]));
  const entries = structuredClone(input.remoteManifest?.entries ?? {});
  const confirmedPaths = new Set<string>();
  const remoteEtags = new Map<string, string | null>();
  let remoteMutated = false;
  let syncedCount = 0;

  if (plan.uploads.length > 0 || plan.trashMoves.length > 0 || input.remoteManifest === null) {
    await repository.ensureLayout();
  }

  if (plan.uploads.length > 0 || plan.trashMoves.length > 0 || input.forceManifestPublish) {
    for (const [resumeId, entry] of Object.entries(entries)) {
      const file = await repository.readResume(entry.path);
      if (!file) return { kind: "deferred", reason: "remote-changed" };
      let parsed: ResumeData;
      try {
        parsed = parseResumeJson(file.text);
      } catch {
        return { kind: "deferred", reason: "remote-changed" };
      }
      if (parsed.id !== resumeId || await calculateResumeHash(parsed) !== entry.contentHash) {
        return { kind: "deferred", reason: "remote-changed" };
      }
      confirmedPaths.add(entry.path);
      remoteEtags.set(entry.path, file.etag);
    }
  }

  for (const upload of plan.uploads) {
    const text = serializeResumeJson(upload.resume);
    const contentHash = await calculateResumeHash(upload.resume);
    try {
      await repository.writeResumeAtomic(
        upload.path,
        text,
        remoteEtags.has(upload.path) ? remoteEtags.get(upload.path) : null,
      );
    } catch (error) {
      if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") {
        return { kind: "deferred", reason: "remote-changed" };
      }
      throw error;
    }
    const confirmed = await verifiedResume(repository, upload.path, contentHash);
    if (!confirmed || confirmed.id !== upload.resume.id) throw new WebDavError("REMOTE_CONTENT_MISMATCH");
    confirmedPaths.add(upload.path);
    if (upload.previousPath && upload.previousPath !== upload.path) {
      const oldEtag = remoteEtags.get(upload.previousPath);
      if (oldEtag !== undefined) {
        try {
          await repository.moveResumeAtomic(upload.previousPath, trashPath(upload.previousPath), oldEtag);
        } catch (error) {
          if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") {
            return { kind: "deferred", reason: "remote-changed" };
          }
          throw error;
        }
      }
    }
    entries[upload.resume.id] = { path: upload.path, contentHash, updatedAt: input.now(), deleted: false };
    remoteMutated = true;
    syncedCount += 1;
  }

  for (const move of plan.trashMoves) {
    const sourceEtag = remoteEtags.get(move.from);
    if (sourceEtag === undefined) return { kind: "deferred", reason: "remote-changed" };
    const previous = entries[move.resumeId];
    if (!previous) return { kind: "deferred", reason: "remote-changed" };
    try {
      await repository.moveResumeAtomic(move.from, move.to, sourceEtag);
    } catch (error) {
      if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") {
        return { kind: "deferred", reason: "remote-changed" };
      }
      throw error;
    }
    if (!await verifiedResume(repository, move.to, previous.contentHash)) {
      return { kind: "deferred", reason: "remote-changed" };
    }
    entries[move.resumeId] = { ...previous, path: move.to, updatedAt: input.now(), deleted: true };
    resumes.delete(move.resumeId);
    remoteMutated = true;
    syncedCount += 1;
  }

  for (const download of plan.downloads) {
    const downloaded = await verifiedResume(repository, download.path, download.contentHash);
    if (!downloaded || downloaded.id !== download.resumeId) return { kind: "deferred", reason: "remote-changed" };
    confirmedPaths.add(download.path);
    resumes.set(download.resumeId, downloaded);
    syncedCount += 1;
  }
  for (const resumeId of plan.remoteDeletions) {
    resumes.delete(resumeId);
    syncedCount += 1;
  }

  let finalManifest = input.remoteManifest;
  if (remoteMutated || finalManifest === null || input.forceManifestPublish) {
    for (const [resumeId, entry] of Object.entries(entries)) {
      if (entry.deleted || confirmedPaths.has(entry.path)) continue;
      const confirmed = await verifiedResume(repository, entry.path, entry.contentHash);
      if (!confirmed || confirmed.id !== resumeId) return { kind: "deferred", reason: "remote-changed" };
      confirmedPaths.add(entry.path);
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
    try {
      await repository.publishManifest(serializeManifest(finalManifest), input.remoteManifestEtag);
    } catch (error) {
      if (error instanceof WebDavError && error.code === "REMOTE_CAS_MISMATCH") {
        return { kind: "deferred", reason: "remote-changed" };
      }
      throw error;
    }
  }

  const data: ResumeSyncData = {
    resumes: Array.from(resumes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    activeResumeId: plan.nextActiveResumeId,
  };
  const baseline = baselineFor(finalManifest);
  try {
    input.commit(data, baseline, input.expectedLocalToken);
  } catch (error) {
    if (error instanceof LocalCasMismatchError) return { kind: "deferred", reason: "local-changed" };
    throw error;
  }
  return { kind: "applied", data, baseline, syncedCount };
}
