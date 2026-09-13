import {
  hasOnlyKeys,
  isResumeData,
  sha256,
  stableStringify,
} from "./resume-codec-core";
import {
  SnapshotValidationError,
  type CloudSnapshotV1,
  type ResumeSyncData,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNonEmptyString = (value: unknown): value is string =>
  isString(value) && value.length > 0;
const isIsoTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export const normalizeSyncData = (data: ResumeSyncData): ResumeSyncData => {
  const resumes = structuredClone(data.resumes).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const activeResumeId = resumes.some((item) => item.id === data.activeResumeId)
    ? data.activeResumeId
    : resumes[0]?.id ?? null;
  return { resumes, activeResumeId };
};

export const canonicalizeSyncData = (data: ResumeSyncData): string =>
  stableStringify(normalizeSyncData(data));

export const calculateContentHash = async (
  data: ResumeSyncData,
): Promise<string> => sha256(canonicalizeSyncData(data));

const validateSnapshotShape = (candidate: unknown): CloudSnapshotV1 => {
  if (!isRecord(candidate)) {
    throw new SnapshotValidationError("SNAPSHOT_SHAPE");
  }
  if (candidate.schemaVersion !== 1) {
    throw new SnapshotValidationError("SNAPSHOT_VERSION");
  }
  if (
    !hasOnlyKeys(candidate, [
      "schemaVersion", "revision", "parentRevision", "updatedAt", "deviceId",
      "contentHash", "data",
    ]) ||
    !isNonEmptyString(candidate.revision) ||
    !(candidate.parentRevision === null || isNonEmptyString(candidate.parentRevision)) ||
    !isIsoTimestamp(candidate.updatedAt) ||
    !isNonEmptyString(candidate.deviceId) ||
    typeof candidate.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.contentHash) ||
    !isRecord(candidate.data) ||
    !hasOnlyKeys(candidate.data, ["resumes", "activeResumeId"]) ||
    !Array.isArray(candidate.data.resumes) ||
    !(candidate.data.activeResumeId === null || isString(candidate.data.activeResumeId))
  ) {
    throw new SnapshotValidationError("SNAPSHOT_SHAPE");
  }
  if (!candidate.data.resumes.every(isResumeData)) {
    throw new SnapshotValidationError("SNAPSHOT_RESUME");
  }
  const ids = candidate.data.resumes.map((resume) => resume.id);
  if (
    new Set(ids).size !== ids.length ||
    (ids.length === 0
      ? candidate.data.activeResumeId !== null
      : candidate.data.activeResumeId !== null && !ids.includes(candidate.data.activeResumeId))
  ) {
    throw new SnapshotValidationError("SNAPSHOT_RESUME");
  }
  return candidate as unknown as CloudSnapshotV1;
};

export const createCloudSnapshot = async (
  data: ResumeSyncData,
  metadata: Omit<CloudSnapshotV1, "schemaVersion" | "contentHash" | "data">,
): Promise<CloudSnapshotV1> => {
  const normalized = normalizeSyncData(data);
  return {
    schemaVersion: 1,
    ...metadata,
    contentHash: await calculateContentHash(normalized),
    data: normalized,
  };
};

export const parseCloudSnapshot = async (
  text: string,
): Promise<CloudSnapshotV1> => {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new SnapshotValidationError("SNAPSHOT_JSON");
  }
  const snapshot = validateSnapshotShape(candidate);
  const data = normalizeSyncData(snapshot.data);
  if (stableStringify(snapshot.data) !== stableStringify(data)) {
    throw new SnapshotValidationError("SNAPSHOT_SHAPE");
  }
  if ((await calculateContentHash(snapshot.data)) !== snapshot.contentHash) {
    throw new SnapshotValidationError("SNAPSHOT_HASH");
  }
  return snapshot;
};
