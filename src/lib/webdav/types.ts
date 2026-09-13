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
