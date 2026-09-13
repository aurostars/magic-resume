import { hasOnlyKeys, sha256, stableStringify } from "./resume-codec-core";
import {
  ManifestValidationError,
  type ManifestV2,
  type ManifestV2Body,
  type ResumeManifestEntry,
} from "./types";

const BODY_KEYS = [
  "schemaVersion", "revision", "parentRevision", "updatedAt", "deviceId",
  "activeResumeId", "entries",
] as const;
const MANIFEST_KEYS = [...BODY_KEYS, "manifestHash"] as const;
const ENTRY_KEYS = ["path", "contentHash", "updatedAt", "deleted"] as const;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
const isIsoTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) && !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const isSafeRelativePosixPath = (value: unknown): value is string => {
  if (!isNonEmptyString(value) || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
};

const isEntry = (value: unknown): value is ResumeManifestEntry =>
  isRecord(value) &&
  hasOnlyKeys(value, ENTRY_KEYS) &&
  isSafeRelativePosixPath(value.path) &&
  typeof value.contentHash === "string" && HASH_PATTERN.test(value.contentHash) &&
  isIsoTimestamp(value.updatedAt) &&
  typeof value.deleted === "boolean";

const validateBody = (candidate: unknown): ManifestV2Body => {
  if (!isRecord(candidate)) throw new ManifestValidationError("MANIFEST_SHAPE");
  if (candidate.schemaVersion !== 2) throw new ManifestValidationError("MANIFEST_VERSION");
  if (
    !hasOnlyKeys(candidate, BODY_KEYS) ||
    !isRevision(candidate.revision) ||
    !(candidate.parentRevision === null || isRevision(candidate.parentRevision)) ||
    !isIsoTimestamp(candidate.updatedAt) ||
    !isNonEmptyString(candidate.deviceId) ||
    !(candidate.activeResumeId === null || isNonEmptyString(candidate.activeResumeId)) ||
    !isRecord(candidate.entries)
  ) {
    throw new ManifestValidationError("MANIFEST_SHAPE");
  }

  const paths = new Set<string>();
  for (const [id, entry] of Object.entries(candidate.entries)) {
    if (!isNonEmptyString(id) || !isEntry(entry)) {
      throw new ManifestValidationError("MANIFEST_SHAPE");
    }
    const directory = entry.deleted ? "trash" : "resumes";
    const fileName = entry.path.split("/").at(-1) ?? "";
    const shortId = id.trim().toLowerCase().slice(0, 6);
    const hasExpectedName = fileName === `${id}.json` || fileName.endsWith(`--${shortId}.json`);
    if (
      !entry.path.startsWith(`${directory}/`) ||
      entry.path.split("/").length !== 2 ||
      !hasExpectedName ||
      paths.has(entry.path)
    ) {
      throw new ManifestValidationError("MANIFEST_SHAPE");
    }
    paths.add(entry.path);
  }

  if (candidate.activeResumeId !== null) {
    const active = candidate.entries[candidate.activeResumeId];
    if (!isEntry(active) || active.deleted) {
      throw new ManifestValidationError("MANIFEST_SHAPE");
    }
  }
  return candidate as unknown as ManifestV2Body;
};

const manifestBody = (manifest: ManifestV2): ManifestV2Body => {
  const { manifestHash: _manifestHash, ...body } = manifest;
  return body;
};

export async function createManifest(body: ManifestV2Body): Promise<ManifestV2> {
  const validBody = validateBody(body);
  return {
    ...validBody,
    manifestHash: await sha256(stableStringify(validBody)),
  };
}

export async function parseManifest(text: string): Promise<ManifestV2> {
  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    throw new ManifestValidationError("MANIFEST_JSON");
  }
  if (!isRecord(candidate)) throw new ManifestValidationError("MANIFEST_SHAPE");
  if (candidate.schemaVersion !== 2) throw new ManifestValidationError("MANIFEST_VERSION");
  if (
    !hasOnlyKeys(candidate, MANIFEST_KEYS) ||
    typeof candidate.manifestHash !== "string" ||
    !HASH_PATTERN.test(candidate.manifestHash)
  ) {
    throw new ManifestValidationError("MANIFEST_SHAPE");
  }
  const manifest = candidate as unknown as ManifestV2;
  const body = validateBody(manifestBody(manifest));
  if ((await sha256(stableStringify(body))) !== manifest.manifestHash) {
    throw new ManifestValidationError("MANIFEST_HASH");
  }
  return manifest;
}

export function serializeManifest(manifest: ManifestV2): string {
  return stableStringify(manifest);
}
