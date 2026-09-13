import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import type { ResumeData } from "../src/types/resume";
import {
  calculateResumeHash,
  getResumeFileName,
  parseResumeJson,
  serializeResumeJson,
} from "../src/lib/webdav/resume-codec";

const createCompleteResume = (
  overrides: Partial<ResumeData> = {},
): ResumeData => ({
  ...structuredClone(initialResumeState),
  id: "resume-id",
  title: "Resume",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  templateId: null,
  ...overrides,
});

const resume = createCompleteResume({
  id: "a81f32ff-1234-4567-8901-123456789012",
  title: '产品/经理: "核心"',
});

test("serializes exactly one import-compatible ResumeData payload", () => {
  const text = serializeResumeJson(resume);
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, resume);
  assert.equal("schemaVersion" in parsed, false);
  assert.equal("contentHash" in parsed, false);
  assert.deepEqual(parseResumeJson(text), resume);
});

test("uses safe title and six-character stable suffix", () => {
  assert.equal(getResumeFileName(resume), "产品_经理_ _核心_--a81f32.json");
});

test("hash ignores object insertion order but detects content changes", async () => {
  const reordered = JSON.parse(JSON.stringify(resume));
  assert.equal(await calculateResumeHash(resume), await calculateResumeHash(reordered));
  assert.notEqual(
    await calculateResumeHash(resume),
    await calculateResumeHash({ ...resume, title: "changed" }),
  );
});
