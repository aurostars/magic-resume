import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import { executeSyncPlan } from "../src/lib/webdav/executor";
import { createManifest, serializeManifest } from "../src/lib/webdav/manifest";
import { calculateResumeHash, serializeResumeJson } from "../src/lib/webdav/resume-codec";
import { LocalCasMismatchError, WebDavError } from "../src/lib/webdav/errors";
import type { ManifestV2, MultiFileBaseline, ResumeSyncData, SyncPlan } from "../src/lib/webdav/types";
import type { ResumeData } from "../src/types/resume";

const NOW = "2026-09-13T03:00:00.000Z";
const resume = (id: string, title = `Resume ${id}`): ResumeData => ({
  ...structuredClone(initialResumeState), id, title,
  createdAt: NOW, updatedAt: NOW, templateId: null,
});
const emptyPlan = (): SyncPlan => ({
  uploads: [], downloads: [], trashMoves: [], remoteDeletions: [], conflicts: [],
  nextActiveResumeId: null,
});

class FakeRepository {
  readonly calls: string[] = [];
  files = new Map<string, { text: string; etag: string | null }>();
  manifestText: string | null = null;
  manifestEtag: string | null = null;
  failWritePath: string | null = null;
  writeEtags = new Map<string, string | null | undefined>();
  failPublish = false;

  async ensureLayout(): Promise<void> { this.calls.push("ensure-layout"); }
  async readManifest() {
    this.calls.push("read-manifest");
    return this.manifestText === null ? null : { path: "manifest.json", text: this.manifestText, etag: this.manifestEtag };
  }
  async readResume(path: string) {
    this.calls.push(`read:${path}`);
    const file = this.files.get(path);
    return file ? { path, ...file } : null;
  }
  async listResumeCandidates() { return []; }
  async writeResumeAtomic(path: string, text: string, expectedEtag?: string | null): Promise<void> {
    this.calls.push(`write:${path}`);
    this.writeEtags.set(path, expectedEtag);
    if (path === this.failWritePath) throw new WebDavError("SERVER", 503);
    this.files.set(path, { text, etag: `etag:${path}` });
  }
  async moveResumeAtomic(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    const file = this.files.get(from);
    if (file) { this.files.set(to, file); this.files.delete(from); }
  }
  async publishManifest(text: string, expectedEtag: string | null): Promise<void> {
    this.calls.push(`publish:${expectedEtag}`);
    if (this.failPublish) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    this.manifestText = text;
  }
}

const setup = async (options: {
  local?: ResumeSyncData;
  remote?: ManifestV2 | null;
  remoteEtag?: string | null;
  plan?: SyncPlan;
} = {}) => {
  const repository = new FakeRepository();
  const local = structuredClone(options.local ?? { resumes: [], activeResumeId: null });
  const remote = options.remote ?? null;
  if (remote) repository.manifestText = serializeManifest(remote);
  repository.manifestEtag = options.remoteEtag ?? (remote ? '"manifest-etag"' : null);
  const commits: Array<{ data: ResumeSyncData; baseline: MultiFileBaseline; token: string }> = [];
  const input = {
    repository,
    plan: options.plan ?? emptyPlan(),
    localData: local,
    remoteManifest: remote,
    remoteManifestEtag: repository.manifestEtag,
    expectedLocalToken: "local-token",
    deviceId: "device-a",
    now: () => NOW,
    commit: (data: ResumeSyncData, baseline: MultiFileBaseline, token: string) => {
      commits.push({ data: structuredClone(data), baseline: structuredClone(baseline), token });
    },
  };
  return { repository, commits, input };
};

const manifest = async (entries: ManifestV2["entries"], activeResumeId: string | null = null) => createManifest({
  schemaVersion: 2, revision: 4, parentRevision: 3, updatedAt: NOW,
  deviceId: "remote", activeResumeId, entries,
});

test("ensures directories before writes and publishes the manifest only after every upload completes", async () => {
  const a = resume("a", "Alpha");
  const b = resume("b", "Beta");
  const plan = emptyPlan();
  plan.uploads = [
    { resume: a, path: "resumes/a.json", previousPath: null },
    { resume: b, path: "resumes/b.json", previousPath: null },
  ];
  plan.nextActiveResumeId = "a";
  const state = await setup({ local: { resumes: [a, b], activeResumeId: "a" }, plan });

  const result = await executeSyncPlan(state.input);

  assert.equal(result.kind, "applied");
  assert.deepEqual(state.repository.calls, [
    "ensure-layout", "write:resumes/a.json", "read:resumes/a.json",
    "write:resumes/b.json", "read:resumes/b.json", "publish:null",
  ]);
  assert.equal(state.commits.length, 1);
});

test("an upload failure never publishes a manifest or commits local state", async () => {
  const item = resume("a");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, path: "resumes/a.json", previousPath: null }];
  const state = await setup({ local: { resumes: [item], activeResumeId: "a" }, plan });
  state.repository.failWritePath = "resumes/a.json";

  await assert.rejects(() => executeSyncPlan(state.input), (error: unknown) => error instanceof WebDavError && error.code === "SERVER");

  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
  assert.equal(state.commits.length, 0);
});

test("parses and hash-verifies a downloaded resume before adding it to committed data", async () => {
  const remoteResume = resume("remote", "Cloud");
  const contentHash = await calculateResumeHash(remoteResume);
  const remote = await manifest({ remote: { path: "resumes/remote.json", contentHash, updatedAt: NOW, deleted: false } }, "remote");
  const plan = emptyPlan();
  plan.downloads = [{ resumeId: "remote", path: "resumes/remote.json", contentHash }];
  plan.nextActiveResumeId = "remote";
  const state = await setup({ remote, plan });
  state.repository.files.set("resumes/remote.json", { text: serializeResumeJson(remoteResume), etag: '"r"' });

  const result = await executeSyncPlan(state.input);

  assert.equal(result.kind, "applied");
  assert.deepEqual(state.commits[0].data, { resumes: [remoteResume], activeResumeId: "remote" });

  state.repository.files.set("resumes/remote.json", { text: serializeResumeJson(resume("remote", "Tampered")), etag: '"r2"' });
  await assert.rejects(() => executeSyncPlan(state.input), (error: unknown) => error instanceof WebDavError && error.code === "REMOTE_CONTENT_MISMATCH");
});

test("a missing downloaded file defers as remote-changed without commit or publication", async () => {
  const remote = await manifest({ a: { path: "resumes/a.json", contentHash: "a".repeat(64), updatedAt: NOW, deleted: false } }, "a");
  const plan = emptyPlan();
  plan.downloads = [{ resumeId: "a", path: "resumes/a.json", contentHash: "a".repeat(64) }];
  const state = await setup({ remote, plan });

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-changed" });
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
  assert.equal(state.commits.length, 0);
});

test("a manifest CAS mismatch defers as remote-changed and does not commit", async () => {
  const item = resume("a");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, path: "resumes/a.json", previousPath: null }];
  const state = await setup({ local: { resumes: [item], activeResumeId: "a" }, plan });
  state.repository.failPublish = true;

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-changed" });
  assert.equal(state.commits.length, 0);
});

test("a local expected-token mismatch defers as local-changed after remote publication", async () => {
  const item = resume("a");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, path: "resumes/a.json", previousPath: null }];
  const state = await setup({ local: { resumes: [item], activeResumeId: "a" }, plan });
  state.input.commit = () => { throw new LocalCasMismatchError(); };

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.calls.at(-1), "publish:null");
});

test("title rename writes and verifies the new path before moving the old path away", async () => {
  const item = resume("a", "New");
  const old = "resumes/Old--a.json";
  const oldResume = resume("a", "Old");
  const oldHash = await calculateResumeHash(oldResume);
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, path: "resumes/New--a.json", previousPath: old }];
  const remote = await manifest({ a: { path: old, contentHash: oldHash, updatedAt: NOW, deleted: false } }, "a");
  const state = await setup({ local: { resumes: [item], activeResumeId: "a" }, remote, plan });
  state.repository.files.set(old, { text: serializeResumeJson(oldResume), etag: '"old"' });

  await executeSyncPlan(state.input);

  assert.deepEqual(state.repository.calls.slice(1), [
    "read:resumes/Old--a.json", "write:resumes/New--a.json",
    "read:resumes/New--a.json", "move:resumes/Old--a.json->trash/Old--a.json",
    "publish:\"manifest-etag\"",
  ]);
});

test("trash move completes before the manifest publishes the deleted entry", async () => {
  const old = "resumes/a.json";
  const deletedResume = resume("a");
  const contentHash = await calculateResumeHash(deletedResume);
  const remote = await manifest({ a: { path: old, contentHash, updatedAt: NOW, deleted: false } }, "a");
  const plan = emptyPlan();
  plan.trashMoves = [{ resumeId: "a", from: old, to: "trash/a.json" }];
  const state = await setup({ remote, plan });
  state.repository.files.set(old, { text: serializeResumeJson(deletedResume), etag: '"old"' });

  await executeSyncPlan(state.input);

  assert.deepEqual(state.repository.calls.slice(1), [
    "read:resumes/a.json", "move:resumes/a.json->trash/a.json", "read:trash/a.json",
    "publish:\"manifest-etag\"",
  ]);
  assert.equal(JSON.parse(state.repository.manifestText!).entries.a.deleted, true);
});

test("overwriting an existing resume uses its inspected ETag as a file-level CAS", async () => {
  const oldResume = resume("a", "Old");
  const nextResume = resume("a", "New");
  const oldHash = await calculateResumeHash(oldResume);
  const remote = await manifest({
    a: { path: "resumes/a.json", contentHash: oldHash, updatedAt: NOW, deleted: false },
  }, "a");
  const plan = emptyPlan();
  plan.uploads = [{ resume: nextResume, path: "resumes/a.json", previousPath: null }];
  const state = await setup({ local: dataFor(nextResume), remote, plan });
  state.repository.files.set("resumes/a.json", { text: serializeResumeJson(oldResume), etag: '"old-etag"' });

  await executeSyncPlan(state.input);

  assert.equal(state.repository.writeEtags.get("resumes/a.json"), '"old-etag"');
});

test("a newly published manifest references only files confirmed available", async () => {
  const upload = resume("a");
  const remoteOnly = resume("b");
  const remoteHash = await calculateResumeHash(remoteOnly);
  const remote = await manifest({
    b: { path: "resumes/b.json", contentHash: remoteHash, updatedAt: NOW, deleted: false },
  }, "b");
  const plan = emptyPlan();
  plan.uploads = [{ resume: upload, path: "resumes/a.json", previousPath: null }];
  const state = await setup({ local: dataFor(upload), remote, plan });

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-changed" });
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
});

const dataFor = (...items: ResumeData[]): ResumeSyncData => ({
  resumes: items,
  activeResumeId: items[0]?.id ?? null,
});

test("conflicts including a hard-deleted remote entry are returned without dereferencing remoteEntry", async () => {
  const item = resume("a");
  const plan = emptyPlan();
  plan.conflicts = [{ resumeId: "a", title: item.title, kind: "delete-vs-modify", local: item, remoteEntry: null }];
  const state = await setup({ local: { resumes: [item], activeResumeId: "a" }, plan });

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "conflict", conflicts: plan.conflicts });
  assert.deepEqual(state.repository.calls, []);
});
