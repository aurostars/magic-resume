import type { ResumeData } from "@/types/resume";
import { assertResumeData, sha256, stableStringify } from "./snapshot";

const INVALID_FILE_NAME_CHAR_REGEX = /[\\/:*?"<>|]/g;

export const getSafeFileName = (title?: string): string => {
  const normalized = (title || "resume")
    .trim()
    .replace(INVALID_FILE_NAME_CHAR_REGEX, "_")
    .replace(/\s+/g, " ");

  return normalized || "resume";
};

const normalizeResumeId = (id: string): string => id.trim().toLowerCase();

export function serializeResumeJson(resume: ResumeData): string {
  assertResumeData(resume);
  return `${JSON.stringify(resume, null, 2)}\n`;
}

export function parseResumeJson(text: string): ResumeData {
  const value: unknown = JSON.parse(text);
  assertResumeData(value);
  return value;
}

export async function calculateResumeHash(resume: ResumeData): Promise<string> {
  assertResumeData(resume);
  return sha256(stableStringify(resume));
}

export function getResumeFileName(resume: ResumeData): string {
  const safeTitle = getSafeFileName(resume.title || "resume");
  const shortId = normalizeResumeId(resume.id).slice(0, 6);
  return `${safeTitle}--${shortId}.json`;
}

export function getResumeRelativePath(resume: ResumeData): string {
  return `resumes/${getResumeFileName(resume)}`;
}

export function getTrashRelativePath(resume: ResumeData): string {
  return `trash/${getResumeFileName(resume)}`;
}
