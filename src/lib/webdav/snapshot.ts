import type { ResumeData } from "@/types/resume";
import {
  SnapshotValidationError,
  type CloudSnapshotV1,
  type ResumeSyncData,
} from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isNullableString = (value: unknown): value is string | null =>
  value === null || isString(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString);
const isArrayOf = (
  value: unknown,
  predicate: (item: unknown) => boolean,
): value is unknown[] => Array.isArray(value) && value.every(predicate);
const isOptional = <T>(
  value: unknown,
  predicate: (item: unknown) => item is T,
): value is T | undefined => value === undefined || predicate(value);

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
};

const isPhotoConfig = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    ["width", "height", "aspectRatio", "borderRadius", "customBorderRadius"],
    ["visible"],
  ) &&
  isNumber(value.width) &&
  isNumber(value.height) &&
  ["1:1", "4:3", "3:4", "16:9", "custom"].includes(String(value.aspectRatio)) &&
  ["none", "medium", "full", "custom"].includes(String(value.borderRadius)) &&
  isNumber(value.customBorderRadius) &&
  isOptional(value.visible, isBoolean);

const isBasicField = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "key", "label", "visible"], ["type", "custom"]) &&
  isString(value.id) &&
  isString(value.key) &&
  isString(value.label) &&
  isBoolean(value.visible) &&
  isOptional(value.type, isString) &&
  isOptional(value.custom, isBoolean);

const isCustomField = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    ["id", "label", "value"],
    ["icon", "visible", "custom", "displayLabel"],
  ) &&
  isString(value.id) &&
  isString(value.label) &&
  isString(value.value) &&
  isOptional(value.icon, isString) &&
  isOptional(value.visible, isBoolean) &&
  isOptional(value.custom, isBoolean) &&
  isOptional(value.displayLabel, isBoolean);

const isBasicInfo = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(
    value,
    [
      "birthDate", "name", "title", "email", "phone", "location", "icons",
      "employementStatus", "photo", "photoConfig", "customFields", "githubKey",
      "githubUseName", "githubContributionsVisible",
    ],
    ["fieldOrder", "layout"],
  ) &&
  isString(value.birthDate) &&
  isString(value.name) &&
  isString(value.title) &&
  isString(value.email) &&
  isString(value.phone) &&
  isString(value.location) &&
  isStringRecord(value.icons) &&
  isString(value.employementStatus) &&
  isString(value.photo) &&
  isPhotoConfig(value.photoConfig) &&
  isOptional(value.fieldOrder, (item): item is unknown[] => isArrayOf(item, isBasicField)) &&
  isArrayOf(value.customFields, isCustomField) &&
  isString(value.githubKey) &&
  isString(value.githubUseName) &&
  isBoolean(value.githubContributionsVisible) &&
  isOptional(value.layout, isString);

const isEducation = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "school", "major", "degree", "startDate", "endDate"], ["gpa", "description", "visible"]) &&
  isString(value.id) &&
  isString(value.school) &&
  isString(value.major) &&
  isString(value.degree) &&
  isString(value.startDate) &&
  isString(value.endDate) &&
  isOptional(value.gpa, isString) &&
  isOptional(value.description, isString) &&
  isOptional(value.visible, isBoolean);

const isExperience = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "company", "position", "date", "details"], ["visible"]) &&
  isString(value.id) &&
  isString(value.company) &&
  isString(value.position) &&
  isString(value.date) &&
  isString(value.details) &&
  isOptional(value.visible, isBoolean);

const isProject = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "name", "role", "date", "description", "visible"], ["link", "linkLabel"]) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.role) &&
  isString(value.date) &&
  isString(value.description) &&
  isBoolean(value.visible) &&
  isOptional(value.link, isString) &&
  isOptional(value.linkLabel, isString);

const isCertificate = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "url", "width"]) &&
  isString(value.id) && isString(value.url) && isNumber(value.width);

const isCustomItem = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "title", "subtitle", "dateRange", "description", "visible"]) &&
  isString(value.id) &&
  isString(value.title) &&
  isString(value.subtitle) &&
  isString(value.dateRange) &&
  isString(value.description) &&
  isBoolean(value.visible);

const isCustomData = (value: unknown): boolean =>
  isRecord(value) &&
  Object.values(value).every((items) => isArrayOf(items, isCustomItem));

const isMenuSection = (value: unknown): boolean =>
  isRecord(value) &&
  hasOnlyKeys(value, ["id", "title", "icon", "enabled", "order"]) &&
  isString(value.id) &&
  isString(value.title) &&
  isString(value.icon) &&
  isBoolean(value.enabled) &&
  isNumber(value.order);

const isGlobalSettings = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const stringKeys = ["themeColor", "fontFamily"];
  const numberKeys = [
    "baseFontSize",
    "pagePadding",
    "paragraphSpacing",
    "lineHeight",
    "sectionSpacing",
    "headerSize",
    "subheaderSize",
  ];
  const booleanKeys = [
    "useIconMode",
    "centerSubtitle",
    "flexibleHeaderLayout",
    "autoOnePage",
    "pageBreakLinesVisible",
  ];
  if (!hasOnlyKeys(value, [], [...stringKeys, ...numberKeys, ...booleanKeys])) {
    return false;
  }
  return (
    stringKeys.every((key) => isOptional(value[key], isString)) &&
    numberKeys.every((key) => isOptional(value[key], isNumber)) &&
    booleanKeys.every((key) => isOptional(value[key], isBoolean))
  );
};

const isResumeData = (value: unknown): value is ResumeData =>
  isRecord(value) &&
  hasOnlyKeys(value, [
    "id", "title", "createdAt", "updatedAt", "templateId", "basic", "education",
    "experience", "projects", "certificates", "customData", "skillContent",
    "selfEvaluationContent", "activeSection", "draggingProjectId", "menuSections",
    "globalSettings",
  ]) &&
  isString(value.id) &&
  value.id.length > 0 &&
  isString(value.title) &&
  isString(value.createdAt) &&
  isString(value.updatedAt) &&
  Object.hasOwn(value, "templateId") &&
  (value.templateId === undefined || isNullableString(value.templateId)) &&
  isBasicInfo(value.basic) &&
  isArrayOf(value.education, isEducation) &&
  isArrayOf(value.experience, isExperience) &&
  isArrayOf(value.projects, isProject) &&
  isArrayOf(value.certificates, isCertificate) &&
  isCustomData(value.customData) &&
  isString(value.skillContent) &&
  isString(value.selfEvaluationContent) &&
  isString(value.activeSection) &&
  isNullableString(value.draggingProjectId) &&
  isArrayOf(value.menuSections, isMenuSection) &&
  isGlobalSettings(value.globalSettings);

const canonicalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeValue(child)]),
    );
  }
  return value;
};

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
  JSON.stringify(canonicalizeValue(normalizeSyncData(data)));

export const calculateContentHash = async (
  data: ResumeSyncData,
): Promise<string> => {
  const bytes = new TextEncoder().encode(canonicalizeSyncData(data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isIsoTimestamp = (value: unknown): value is string =>
  isNonEmptyString(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

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
  if (
    JSON.stringify(canonicalizeValue(snapshot.data)) !==
    JSON.stringify(canonicalizeValue(data))
  ) {
    throw new SnapshotValidationError("SNAPSHOT_SHAPE");
  }
  if ((await calculateContentHash(snapshot.data)) !== snapshot.contentHash) {
    throw new SnapshotValidationError("SNAPSHOT_HASH");
  }
  return snapshot;
};
