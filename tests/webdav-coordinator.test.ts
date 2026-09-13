import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import { WebDavSyncCoordinator } from "../src/lib/webdav/coordinator";
import { LocalCasMismatchError, WebDavError } from "../src/lib/webdav/errors";
import { createManifest, parseManifest, serializeManifest } from "../src/lib/webdav/manifest";
import { calculateResumeHash, serializeResumeJson } from "../src/lib/webdav/resume-codec";
import { canonicalizeSyncData } from "../src/lib/webdav/snapshot";
import type { ManifestV2, MultiFileBaseline, ResumeSyncData } from "../src/lib/webdav/types";
import type { ResumeData } from "../src/types/resume";

const NOW = "2026-09-13T03:00:00.000Z";
const resume = (id: string, title = `Resume ${id}`): ResumeData => ({
  ...structuredClone(initialResumeState), id, title,
  createdAt: NOW, updatedAt: NOW, templateId: null,
});
const data = (...resumes: ResumeData[]): ResumeSyncData => ({
  resumes, activeResumeId: resumes[0]?.id ?? null,
});
const baselineFor = (manifest: ManifestV2): MultiFileBaseline => ({
  manifestRevision: manifest.revision,
  manifestHash: manifest.manifestHash,
  activeResumeId: manifest.activeResumeId,
  entries: Object.fromEntries(Object.entries(manifest.entries).map(([id, entry]) => [id, {
    objectPath: entry.objectPath, mirrorPath: entry.mirrorPath,
    contentHash: entry.contentHash, deleted: entry.deleted,
  }])),
});
const makeManifest = async (items: ResumeData[], revision = 1): Promise<ManifestV2> => {
  const entries: ManifestV2["entries"] = {};
  for (const item of items) {
    const contentHash = await calculateResumeHash(item);
    entries[item.id] = {
      objectPath: `objects/${item.id}/${contentHash}.json`,
      mirrorPath: `resumes/${item.title}--${item.id.slice(0, 6).toLowerCase()}.json`,
      contentHash,
      updatedAt: NOW, deleted: false,
    };
  }
  return createManifest({
    schemaVersion: 2, revision, parentRevision: revision === 1 ? null : revision - 1,
    updatedAt: NOW, deviceId: "remote", activeResumeId: items[0]?.id ?? null, entries,
  });
};

class MemoryRepository {
  manifest: { text: string; etag: string | null } | null = null;
  files = new Map<string, { text: string; etag: string | null }>();
  trashCandidates = new Set<string>();
  calls: string[] = [];
  publishRaces = 0;

  async ensureLayout() { this.calls.push("ensure-layout"); }
  async ensureObjectDirectory(id: string) { this.calls.push(`ensure-object:${id}`); }
  async readManifest() {
    this.calls.push("read-manifest");
    return this.manifest ? { path: "manifest.json", ...this.manifest } : null;
  }
  async readResume(path: string) {
    this.calls.push(`read:${path}`);
    const file = this.files.get(path);
    return file ? { path, ...file } : null;
  }
  async listResumeCandidates() {
    this.calls.push("list:resumes/");
    return [...this.files.keys()].filter((path) => path.startsWith("resumes/"))
      .map((path) => ({ path, etag: this.files.get(path)?.etag ?? null }));
  }
  async writeResumeAtomic(path: string, text: string) {
    this.calls.push(`write:${path}`);
    this.files.set(path, { text, etag: `etag:${path}` });
  }
  async moveResumeAtomic(from: string, to: string) {
    this.calls.push(`move:${from}->${to}`);
    const value = this.files.get(from);
    if (value) { this.files.delete(from); this.files.set(to, value); }
  }
  async publishManifest(text: string, expectedEtag: string | null) {
    this.calls.push(`publish:${expectedEtag}`);
    if (this.publishRaces-- > 0) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    this.manifest = { text, etag: '"next"' };
  }
  async deleteManifest(expectedEtag: string) {
    this.calls.push(`delete-manifest:${expectedEtag}`);
    if (this.manifest?.etag !== expectedEtag) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    this.manifest = null;
  }
}

const setup = async (options: {
  local?: ResumeSyncData;
  remote?: ManifestV2 | null;
  baseline?: MultiFileBaseline | null;
} = {}) => {
  const repository = new MemoryRepository();
  if (options.remote) {
    repository.manifest = { text: serializeManifest(options.remote), etag: '"m1"' };
  }
  let local = structuredClone(options.local ?? data());
  let baseline = structuredClone(options.baseline ?? null);
  let commits = 0;
  let localRace = false;
  const coordinator = new WebDavSyncCoordinator({
    repository,
    getLocalData: () => structuredClone(local),
    subscribeLocalData: () => () => undefined,
    getBaseline: () => structuredClone(baseline),
    commit: (next, nextBaseline, expectedToken) => {
      commits += 1;
      if (localRace || canonicalizeSyncData(local) !== expectedToken) throw new LocalCasMismatchError();
      local = structuredClone(next);
      baseline = structuredClone(nextBaseline);
    },
    deviceId: "local",
    now: () => NOW,
  });
  return {
    repository, coordinator,
    local: () => local, baseline: () => baseline, commits: () => commits,
    setLocalRace: (value: boolean) => { localRace = value; },
  };
};

const seedRemoteFiles = async (repository: MemoryRepository, items: ResumeData[]) => {
  for (const item of items) {
    const hash = await calculateResumeHash(item);
    const value = { text: serializeResumeJson(item), etag: `"${item.id}"` };
    repository.files.set(`objects/${item.id}/${hash}.json`, value);
    repository.files.set(`resumes/${item.title}--${item.id.slice(0, 6).toLowerCase()}.json`, value);
  }
};

test("first local-only sync uploads resumes then creates revision 1 and commits a matching baseline", async () => {
  const local = resume("local");
  const state = await setup({ local: data(local) });

  const result = await state.coordinator.execute();

  assert.deepEqual(result, { status: "uploaded", warning: null, syncedCount: 1 });
  const published = await parseManifest(state.repository.manifest!.text);
  assert.equal(published.revision, 1);
  assert.equal(published.parentRevision, null);
  const publishIndex = state.repository.calls.indexOf("publish:null");
  const mirrorWriteIndex = state.repository.calls.findIndex((call) => call.startsWith("write:resumes/"));
  assert.ok(publishIndex >= 0 && mirrorWriteIndex > publishIndex);
  assert.deepEqual(state.baseline(), baselineFor(published));
});

test("cloud-only bootstrap downloads verified resumes and atomically commits them", async () => {
  const cloud = resume("cloud");
  const remote = await makeManifest([cloud]);
  const state = await setup({ remote });
  await seedRemoteFiles(state.repository, [cloud]);

  const result = await state.coordinator.execute();

  assert.deepEqual(result, { status: "downloaded", warning: null, syncedCount: 1 });
  assert.deepEqual(state.local(), data(cloud));
  assert.equal(state.commits(), 1);
});

test("an unchanged synchronized state does not rewrite files or manifest", async () => {
  const same = resume("same");
  const remote = await makeManifest([same]);
  const state = await setup({ local: data(same), remote, baseline: baselineFor(remote) });
  await seedRemoteFiles(state.repository, [same]);

  assert.deepEqual(await state.coordinator.execute(), { status: "unchanged", warning: null, syncedCount: 0 });
  assert.equal(state.commits(), 0);
  assert.equal(state.repository.calls.some((call) => call.startsWith("write:") || call.startsWith("publish:")), false);
});

test("independent local and remote changes upload one resume and download the other", async () => {
  const oldA = resume("a", "Old A");
  const oldB = resume("b", "Old B");
  const base = await makeManifest([oldA, oldB]);
  const localA = resume("a", "Local A");
  const cloudB = resume("b", "Cloud B");
  const remote = await makeManifest([oldA, cloudB], 2);
  const state = await setup({ local: data(localA, oldB), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(state.repository, [oldA, cloudB]);

  const result = await state.coordinator.execute();

  assert.equal(result.status, "uploaded");
  assert.equal(result.syncedCount, 2);
  assert.deepEqual(state.local().resumes.map((item) => item.title), ["Local A", "Cloud B"]);
});

test("both-modified and hard-delete conflicts are resume scoped and resolution affects only that resume", async () => {
  const baseA = resume("a", "Base A");
  const baseB = resume("b", "Base B");
  const base = await makeManifest([baseA, baseB]);
  const localA = resume("a", "Local A");
  const localB = resume("b", "Local B");
  const cloudA = resume("a", "Cloud A");
  const remote = await makeManifest([cloudA], 2);
  const state = await setup({ local: data(localA, localB), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(state.repository, [cloudA]);

  const inspection = await state.coordinator.inspect();

  assert.equal(inspection.decision, "conflict");
  assert.deepEqual(inspection.conflicts.map((item) => [item.resumeId, item.kind, item.remoteEntry]), [
    ["a", "both-modified", remote.entries.a],
    ["b", "delete-vs-modify", null],
  ]);

  const unresolved = await state.coordinator.execute({
    resumeId: "a", resolution: "use-cloud", seenRemoteEtag: '"m1"', seenManifestRevision: 2,
  });
  assert.equal("decision" in unresolved && unresolved.decision, "conflict");
  if (!("decision" in unresolved)) assert.fail("expected conflict");
  assert.deepEqual(unresolved.conflicts.map((item) => item.resumeId), ["b"]);
});

test("keep-local and use-cloud resolutions execute the selected resume outcome", async () => {
  const baseItem = resume("a", "Base");
  const base = await makeManifest([baseItem]);
  const local = resume("a", "Local");
  const cloud = resume("a", "Cloud");
  const remote = await makeManifest([cloud], 2);

  const keep = await setup({ local: data(local), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(keep.repository, [cloud]);
  assert.equal((await keep.coordinator.execute({
    resumeId: "a", resolution: "keep-local", seenRemoteEtag: '"m1"', seenManifestRevision: 2,
  })).status, "uploaded");
  const keptManifest = await parseManifest(keep.repository.manifest!.text);
  assert.equal(parseResumeTitle(keep.repository.files.get(keptManifest.entries.a.objectPath)!.text), "Local");

  const use = await setup({ local: data(local), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(use.repository, [cloud]);
  assert.equal((await use.coordinator.execute({
    resumeId: "a", resolution: "use-cloud", seenRemoteEtag: '"m1"', seenManifestRevision: 2,
  })).status, "downloaded");
  assert.equal(use.local().resumes[0].title, "Cloud");
});

const parseResumeTitle = (text: string): string => (JSON.parse(text) as ResumeData).title;

test("remote and local CAS races are bounded and always reread and replan", async () => {
  const local = resume("a");
  const remoteRace = await setup({ local: data(local) });
  remoteRace.repository.publishRaces = 3;

  assert.deepEqual(await remoteRace.coordinator.execute(), {
    status: "deferred", warning: null, reason: "REMOTE_CHANGED",
  });
  assert.equal(remoteRace.repository.calls.filter((call) => call === "read-manifest").length, 3);

  const cloud = resume("cloud");
  const remote = await makeManifest([cloud]);
  const localRace = await setup({ remote });
  await seedRemoteFiles(localRace.repository, [cloud]);
  localRace.setLocalRace(true);
  assert.deepEqual(await localRace.coordinator.execute(), {
    status: "deferred", warning: null, reason: "LOCAL_CHANGED",
  });
  assert.equal(localRace.repository.calls.filter((call) => call === "read-manifest").length, 3);
});

test("manual discovery scans resumes only, imports valid JSON, and surfaces sanitized invalid warnings", async () => {
  const indexed = resume("indexed");
  const manual = resume("manual");
  const ignoredTrash = resume("trash-only");
  const remote = await makeManifest([indexed]);
  const state = await setup({ remote });
  await seedRemoteFiles(state.repository, [indexed]);
  state.repository.files.set("resumes/manual.json", { text: serializeResumeJson(manual), etag: '"manual"' });
  state.repository.files.set("resumes/bad.json", { text: "{secret malformed", etag: '"bad"' });
  state.repository.files.set("trash/trash-only.json", { text: serializeResumeJson(ignoredTrash), etag: '"trash"' });

  const inspection = await state.coordinator.inspect();

  assert.deepEqual(inspection.warnings, [{ code: "INVALID_REMOTE_RESUME" }]);
  assert.deepEqual(inspection.plan.downloads.map((item) => item.resumeId), ["indexed", "manual"]);
  assert.equal(state.repository.calls.includes("read:trash/trash-only.json"), false);
});

test("conflict decisions are rejected when the visible manifest ETag or revision is stale", async () => {
  const baseItem = resume("a", "Base");
  const local = resume("a", "Local");
  const cloud = resume("a", "Cloud");
  const base = await makeManifest([baseItem]);
  const remote = await makeManifest([cloud], 2);
  const state = await setup({ local: data(local), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(state.repository, [cloud]);

  const byEtag = await state.coordinator.execute({
    resumeId: "a", resolution: "keep-local", seenRemoteEtag: '"stale"', seenManifestRevision: 2,
  });
  const byRevision = await state.coordinator.execute({
    resumeId: "a", resolution: "use-cloud", seenRemoteEtag: '"m1"', seenManifestRevision: 1,
  });

  assert.deepEqual(byEtag, { status: "deferred", warning: null, reason: "REMOTE_CHANGED" });
  assert.deepEqual(byRevision, { status: "deferred", warning: null, reason: "REMOTE_CHANGED" });
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
  assert.equal(state.commits(), 0);
});

test("runtime conflict decisions missing either freshness field are rejected, including null ETag revisions", async () => {
  const baseItem = resume("a", "Base");
  const local = resume("a", "Local");
  const cloud = resume("a", "Cloud");
  const base = await makeManifest([baseItem]);
  const remote = await makeManifest([cloud], 2);
  const state = await setup({ local: data(local), remote, baseline: baselineFor(base) });
  await seedRemoteFiles(state.repository, [cloud]);

  for (const invalid of [
    { resumeId: "a", resolution: "keep-local", seenManifestRevision: 2 },
    { resumeId: "a", resolution: "keep-local", seenRemoteEtag: '"m1"' },
  ]) {
    assert.deepEqual(await state.coordinator.execute(invalid as never), {
      status: "deferred", warning: null, reason: "REMOTE_CHANGED",
    });
  }
  state.repository.manifest!.etag = null;
  assert.deepEqual(await state.coordinator.execute({
    resumeId: "a", resolution: "keep-local", seenRemoteEtag: null, seenManifestRevision: 1,
  }), { status: "deferred", warning: null, reason: "REMOTE_CHANGED" });
});

test("manual mirrors with one ID are deterministic: equal hashes dedupe and different hashes are ambiguous", async () => {
  const remote = await makeManifest([]);
  const same = resume("manual-id", "Same");
  const changed = resume("manual-id", "Changed");
  const run = async (paths: Array<[string, ResumeData]>) => {
    const state = await setup({ remote });
    for (const [path, value] of paths) state.repository.files.set(path, {
      text: serializeResumeJson(value), etag: `etag:${path}`,
    });
    return state.coordinator.inspect();
  };

  const deduped = await run([["resumes/z.json", same], ["resumes/a.json", same]]);
  assert.equal(deduped.plan.manualImports?.length, 1);
  assert.equal(deduped.plan.manualImports?.[0].mirrorPath, "resumes/a.json");

  const forward = await run([["resumes/a.json", same], ["resumes/z.json", changed]]);
  const reverse = await run([["resumes/z.json", changed], ["resumes/a.json", same]]);
  for (const inspection of [forward, reverse]) {
    assert.deepEqual(inspection.warnings, [{ code: "AMBIGUOUS_REMOTE_RESUME" }]);
    assert.equal(inspection.plan.manualImports?.length, 0);
    assert.equal(inspection.plan.downloads.some((item) => item.resumeId === "manual-id"), false);
  }
});
