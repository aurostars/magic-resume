import type { ResumeData } from "@/types/resume";

export interface ResumeSyncData {
  resumes: ResumeData[];
  activeResumeId: string | null;
}

export interface WebDavBaseline {
  revision: string;
  contentHash: string;
  syncedAt: string;
}

export interface CloudSnapshotV1 {
  schemaVersion: 1;
  revision: string;
  parentRevision: string | null;
  updatedAt: string;
  deviceId: string;
  contentHash: string;
  data: ResumeSyncData;
}

export interface ResumeManifestEntry {
  path: string;
  contentHash: string;
  updatedAt: string;
  deleted: boolean;
}

export interface ManifestV2Body {
  schemaVersion: 2;
  revision: number;
  parentRevision: number | null;
  updatedAt: string;
  deviceId: string;
  activeResumeId: string | null;
  entries: Record<string, ResumeManifestEntry>;
}

export interface ManifestV2 extends ManifestV2Body {
  manifestHash: string;
}

export interface MultiFileBaselineEntry {
  contentHash: string;
  deleted: boolean;
  path: string;
}

export interface MultiFileBaseline {
  manifestRevision: number;
  manifestHash: string;
  activeResumeId: string | null;
  entries: Record<string, MultiFileBaselineEntry>;
}

export type ResumeConflictKind = "both-modified" | "delete-vs-modify";

export interface ResumeSyncConflict {
  resumeId: string;
  title: string;
  kind: ResumeConflictKind;
  local: ResumeData | null;
  remoteEntry: ResumeManifestEntry;
}

export interface SyncPlan {
  uploads: Array<{ resume: ResumeData; path: string; previousPath: string | null }>;
  downloads: Array<{ resumeId: string; path: string; contentHash: string }>;
  trashMoves: Array<{ resumeId: string; from: string; to: string }>;
  remoteDeletions: string[];
  conflicts: ResumeSyncConflict[];
  nextActiveResumeId: string | null;
}

export interface PlanSyncInput {
  local: ResumeSyncData;
  localHashes: Record<string, string>;
  remote: ManifestV2 | null;
  baseline: MultiFileBaseline | null;
}

export type ManifestValidationCode =
  | "MANIFEST_JSON"
  | "MANIFEST_VERSION"
  | "MANIFEST_SHAPE"
  | "MANIFEST_HASH";

export class ManifestValidationError extends Error {
  constructor(public readonly code: ManifestValidationCode) {
    super(code);
    this.name = "ManifestValidationError";
  }
}

export type SnapshotValidationCode =
  | "SNAPSHOT_JSON"
  | "SNAPSHOT_VERSION"
  | "SNAPSHOT_SHAPE"
  | "SNAPSHOT_RESUME"
  | "SNAPSHOT_HASH";

export class SnapshotValidationError extends Error {
  constructor(public readonly code: SnapshotValidationCode) {
    super(code);
    this.name = "SnapshotValidationError";
  }
}
