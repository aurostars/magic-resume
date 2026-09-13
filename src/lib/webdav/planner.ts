import { getResumeRelativePath } from "./resume-codec";
import type {
  PlanSyncInput,
  ResumeManifestEntry,
  ResumeSyncConflict,
  SyncPlan,
} from "./types";

const compareIds = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const remoteTitle = (entry: ResumeManifestEntry): string => {
  const fileName = entry.path.split("/").at(-1) ?? entry.path;
  return fileName.replace(/\.json$/, "").replace(/--[^-]*$/, "");
};

const trashPathFor = (path: string): string =>
  `trash/${path.split("/").at(-1) ?? path}`;

export function planSync(input: PlanSyncInput): SyncPlan {
  const localById = new Map(input.local.resumes.map((resume) => [resume.id, resume]));
  const remoteEntries = input.remote?.entries ?? {};
  const baselineEntries = input.baseline?.entries ?? {};
  const ids = Array.from(new Set([
    ...input.local.resumes.map((resume) => resume.id),
    ...Object.keys(remoteEntries),
    ...Object.keys(baselineEntries),
  ])).sort(compareIds);

  const plan: SyncPlan = {
    uploads: [],
    downloads: [],
    trashMoves: [],
    remoteDeletions: [],
    conflicts: [],
    nextActiveResumeId: null,
  };

  for (const resumeId of ids) {
    const local = localById.get(resumeId) ?? null;
    const localHash = local ? input.localHashes[resumeId] : null;
    const remoteEntry = remoteEntries[resumeId];
    const previous = baselineEntries[resumeId];

    if (!previous) {
      if (local && (!remoteEntry || remoteEntry.deleted)) {
        plan.uploads.push({
          resume: local,
          path: getResumeRelativePath(local),
          previousPath: null,
        });
      } else if (!local && remoteEntry && !remoteEntry.deleted) {
        plan.downloads.push({
          resumeId,
          path: remoteEntry.path,
          contentHash: remoteEntry.contentHash,
        });
      } else if (local && remoteEntry && localHash !== remoteEntry.contentHash) {
        plan.conflicts.push({
          resumeId,
          title: local.title,
          kind: "both-modified",
          local,
          remoteEntry,
        });
      }
      continue;
    }

    const localDeleted = !local;
    const remoteDeleted = !remoteEntry || remoteEntry.deleted;
    const localChanged = localDeleted !== previous.deleted ||
      (!localDeleted && localHash !== previous.contentHash);
    const remoteChanged = remoteDeleted !== previous.deleted ||
      (!remoteDeleted && remoteEntry.contentHash !== previous.contentHash);

    if (!localChanged && !remoteChanged) continue;

    if (localChanged && remoteChanged) {
      if (localDeleted && remoteDeleted) continue;
      if (!localDeleted && !remoteDeleted && localHash === remoteEntry.contentHash) continue;

      plan.conflicts.push({
        resumeId,
        title: local?.title ?? (remoteEntry ? remoteTitle(remoteEntry) : resumeId),
        kind: localDeleted || remoteDeleted ? "delete-vs-modify" : "both-modified",
        local,
        remoteEntry: remoteEntry ?? null,
      });
      continue;
    }

    if (localChanged) {
      if (localDeleted) {
        if (remoteEntry && !remoteEntry.deleted) {
          plan.trashMoves.push({
            resumeId,
            from: remoteEntry.path,
            to: trashPathFor(remoteEntry.path),
          });
        }
      } else {
        const path = getResumeRelativePath(local);
        plan.uploads.push({
          resume: local,
          path,
          previousPath: remoteEntry && !remoteEntry.deleted && remoteEntry.path !== path
            ? remoteEntry.path
            : null,
        });
      }
      continue;
    }

    if (remoteDeleted) {
      if (local) plan.remoteDeletions.push(resumeId);
    } else {
      plan.downloads.push({
        resumeId,
        path: remoteEntry.path,
        contentHash: remoteEntry.contentHash,
      });
    }
  }

  const removedIds = new Set([
    ...plan.remoteDeletions,
    ...plan.trashMoves.map(({ resumeId }) => resumeId),
  ]);
  const liveIds = ids.filter((id) => {
    if (removedIds.has(id)) return false;
    if (localById.has(id)) return true;
    const entry = remoteEntries[id];
    return Boolean(entry && !entry.deleted);
  });
  const preferredIds = [input.remote?.activeResumeId, input.local.activeResumeId];
  plan.nextActiveResumeId = preferredIds.find(
    (id): id is string => id !== null && id !== undefined && liveIds.includes(id),
  ) ?? liveIds[0] ?? null;

  return plan;
}
