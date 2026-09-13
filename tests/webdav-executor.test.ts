import assert from "node:assert/strict";
import test from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import { executeSyncPlan } from "../src/lib/webdav/executor";
import { createManifest, parseManifest, serializeManifest } from "../src/lib/webdav/manifest";
import { calculateResumeHash, serializeResumeJson } from "../src/lib/webdav/resume-codec";
import { LocalCasMismatchError, WebDavError } from "../src/lib/webdav/errors";
import type { ManifestPublishOperation } from "../src/lib/webdav/repository";
import type { ManifestV2, MultiFileBaseline, ResumeSyncData, SyncPlan } from "../src/lib/webdav/types";
import type { ResumeData } from "../src/types/resume";

const NOW = "2026-09-13T03:00:00.000Z";
const resume = (id: string, title = `Resume ${id}`, updatedAt = NOW): ResumeData => ({
  ...structuredClone(initialResumeState), id, title,
  createdAt: NOW, updatedAt, templateId: null,
});
const data = (...items: ResumeData[]): ResumeSyncData => ({
  resumes: items, activeResumeId: items[0]?.id ?? null,
});
const emptyPlan = (): SyncPlan => ({
  uploads: [], downloads: [], trashMoves: [], remoteDeletions: [], conflicts: [],
  nextActiveResumeId: null,
});
const objectPath = (id: string, hash: string): string => `objects/${id}/${hash}.json`;

class FakeRepository {
  readonly calls: string[] = [];
  readonly files = new Map<string, { text: string; etag: string | null }>();
  manifestText: string | null = null;
  manifestEtag: string | null = null;
  failPublish = false;
  failMirror = false;
  publishNetworkError = false;
  deferredMove: "delete-wins" | "move-wins" | "third-party" | "source-lost" | null = null;
  thirdPartyManifestText: string | null = null;
  pendingPublish: { operation: ManifestPublishOperation; text: string } | null = null;
  preparedManifestText = "";
  temporarySourceExists = false;
  manifestPublishSupported = false;
  deferredMoveAfterReads = Number.POSITIVE_INFINITY;
  destinationReadsAfterError = 0;
  restoreNetworkError = false;
  cancelSourceError: WebDavError | null = null;
  lateMoveFailed = false;
  onPrepare: (() => void) | null = null;
  onWrite: ((path: string) => void) | null = null;
  onCapabilityCheck: ((signal?: AbortSignal) => void | Promise<void>) | null = null;
  onPublish: ((signal?: AbortSignal) => void | Promise<void>) | null = null;
  onReadManifest: (() => void) | null = null;
  onRestore: (() => void) | null = null;
  seenSignals: Array<AbortSignal | undefined> = [];

  async ensureLayout(signal?: AbortSignal) { this.calls.push("ensure-layout"); this.seenSignals.push(signal); }
  async ensureObjectDirectory(id: string, signal?: AbortSignal) { this.calls.push(`ensure-object:${id}`); this.seenSignals.push(signal); }
  async readManifest(signal?: AbortSignal) {
    this.calls.push("read-manifest"); this.seenSignals.push(signal);
    this.onReadManifest?.();
    if (this.pendingPublish && ++this.destinationReadsAfterError >= this.deferredMoveAfterReads) {
      if (this.temporarySourceExists) this.completePendingMove();
      else this.lateMoveFailed = true;
    }
    return this.manifestText === null ? null : { path: "manifest.json", text: this.manifestText, etag: this.manifestEtag };
  }
  async readResume(path: string, signal?: AbortSignal) {
    this.calls.push(`read:${path}`); this.seenSignals.push(signal);
    const file = this.files.get(path);
    return file ? { path, ...file } : null;
  }
  async writeResumeAtomic(path: string, text: string, _etag?: string | null, signal?: AbortSignal) {
    this.calls.push(`write:${path}`); this.seenSignals.push(signal);
    if (this.failMirror && (path.startsWith("resumes/") || path.startsWith("trash/"))) {
      throw new WebDavError("SERVER", 503);
    }
    this.files.set(path, { text, etag: `etag:${path}` });
    this.onWrite?.(path);
  }
  async moveResumeAtomic(from: string, to: string, _etag?: string | null, signal?: AbortSignal) {
    this.calls.push(`move:${from}->${to}`); this.seenSignals.push(signal);
    if (this.failMirror) throw new WebDavError("SERVER", 503);
    const file = this.files.get(from);
    if (file) { this.files.set(to, file); this.files.delete(from); }
  }
  async ensureManifestPublishSupported(signal?: AbortSignal) {
    this.calls.push("preflight"); this.seenSignals.push(signal);
    await this.onCapabilityCheck?.(signal);
    signal?.throwIfAborted();
    this.manifestPublishSupported = true;
  }
  async prepareManifestPublish(text: string, expectedEtag: string | null, signal?: AbortSignal) {
    this.calls.push(`prepare:${expectedEtag}`); this.seenSignals.push(signal);
    this.preparedManifestText = text;
    this.temporarySourceExists = true;
    this.onPrepare?.();
    return {
      sourcePath: "/magic-resume/manifest.json.tmp-device-a-operation",
      sourceEtag: '"temp-etag"',
      destinationPrecondition: expectedEtag === null
        ? { kind: "missing" as const }
        : { kind: "match" as const, etag: expectedEtag },
    };
  }
  async commitManifestPublish(operation: ManifestPublishOperation, signal?: AbortSignal) {
    if (!this.manifestPublishSupported) {
      await this.ensureManifestPublishSupported(signal);
    }
    const expectedEtag = operation.destinationPrecondition.kind === "match"
      ? operation.destinationPrecondition.etag
      : null;
    this.calls.push(`publish:${expectedEtag}`); this.seenSignals.push(signal);
    await this.onPublish?.(signal);
    if (signal?.aborted) throw signal.reason;
    if (this.failPublish) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    if (this.restoreNetworkError && expectedEtag === '"published"') {
      this.restoreNetworkError = false;
      this.pendingPublish = { operation, text: this.preparedManifestText };
      throw new WebDavError("NETWORK");
    }
    if (this.publishNetworkError) {
      this.publishNetworkError = false;
      this.pendingPublish = { operation, text: this.preparedManifestText };
      if (this.deferredMove === "source-lost") this.temporarySourceExists = false;
      throw new WebDavError("NETWORK");
    }
    if (expectedEtag === '"published"') this.onRestore?.();
    if (expectedEtag !== this.manifestEtag) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    this.manifestText = this.preparedManifestText;
    this.manifestEtag = '"published"';
    this.temporarySourceExists = false;
  }
  async cancelManifestPublish(operation: ManifestPublishOperation, signal?: AbortSignal) {
    this.calls.push(`cancel-source:${operation.sourceEtag}`); this.seenSignals.push(signal);
    if (this.cancelSourceError) throw this.cancelSourceError;
    if (this.pendingPublish && this.deferredMove === "move-wins") this.completePendingMove();
    if (this.pendingPublish && this.deferredMove === "third-party") {
      this.temporarySourceExists = false;
      this.manifestText = this.thirdPartyManifestText;
      this.manifestEtag = '"third-party"';
    }
    if (!this.temporarySourceExists) throw new WebDavError("NOT_FOUND", 404);
    this.temporarySourceExists = false;
  }
  private completePendingMove() {
    if (!this.pendingPublish || !this.temporarySourceExists) return;
    this.manifestText = this.pendingPublish.text;
    this.manifestEtag = '"published"';
    this.temporarySourceExists = false;
    this.pendingPublish = null;
  }
  async deleteManifest(expectedEtag: string, signal?: AbortSignal) {
    this.calls.push(`delete-manifest:${expectedEtag}`); this.seenSignals.push(signal);
    if (this.manifestEtag !== expectedEtag) throw new WebDavError("REMOTE_CAS_MISMATCH", 412);
    this.manifestText = null;
    this.manifestEtag = null;
  }
}

const entryFor = async (item: ResumeData, mirrorPath = `resumes/${item.title}--${item.id.slice(0, 6).toLowerCase()}.json`) => {
  const contentHash = await calculateResumeHash(item);
  return {
    objectPath: objectPath(item.id, contentHash), mirrorPath,
    contentHash, updatedAt: item.updatedAt, deleted: false,
  };
};
const manifest = async (entries: ManifestV2["entries"], activeResumeId: string | null = null) => createManifest({
  schemaVersion: 2, revision: 4, parentRevision: 3, updatedAt: NOW,
  deviceId: "remote", activeResumeId, entries,
});
const setup = (options: { local?: ResumeSyncData; remote?: ManifestV2 | null; plan?: SyncPlan } = {}) => {
  const repository = new FakeRepository();
  const remote = options.remote ?? null;
  if (remote) repository.manifestText = serializeManifest(remote);
  repository.manifestEtag = remote ? '"manifest-etag"' : null;
  const commits: Array<{ data: ResumeSyncData; baseline: MultiFileBaseline }> = [];
  let localToken = "stable-token";
  const listeners = new Set<() => void>();
  return {
    repository,
    commits,
    getListenerCount: () => listeners.size,
    setLocalToken: (value: string) => {
      localToken = value;
      for (const listener of [...listeners]) listener();
    },
    input: {
      repository,
      plan: options.plan ?? emptyPlan(),
      localData: structuredClone(options.local ?? data()),
      remoteManifest: remote,
      previousManifest: remote,
      remoteManifestEtag: repository.manifestEtag,
      expectedLocalToken: "stable-token",
      getLocalToken: () => localToken,
      subscribeLocalToken: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      deviceId: "device-a",
      now: () => NOW,
      commit: (next: ResumeSyncData, baseline: MultiFileBaseline) => {
        if (localToken !== "stable-token") throw new LocalCasMismatchError();
        commits.push({ data: structuredClone(next), baseline: structuredClone(baseline) });
      },
    },
  };
};

const seed = (repository: FakeRepository, path: string, item: ResumeData) => {
  repository.files.set(path, { text: serializeResumeJson(item), etag: `etag:${path}` });
};

test("initial local token mismatch defers before ensureLayout or any repository call", async () => {
  const item = resume("local");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Local--local.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  state.setLocalToken("changed-before-start");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.deepEqual(state.repository.calls, []);
});

test("uploads and verifies immutable objects, publishes manifest, then writes readable mirrors", async () => {
  const item = resume("resume-full-id", "Readable");
  const hash = await calculateResumeHash(item);
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Readable--resume.json", previousMirrorPath: null }];
  plan.nextActiveResumeId = item.id;
  const state = setup({ local: data(item), plan });

  const result = await executeSyncPlan(state.input);

  assert.equal(result.kind, "applied");
  assert.deepEqual(state.repository.calls, [
    "ensure-layout", `ensure-object:${item.id}`,
    `read:${objectPath(item.id, hash)}`, `write:${objectPath(item.id, hash)}`,
    `read:${objectPath(item.id, hash)}`, `read:${objectPath(item.id, hash)}`, "preflight", "prepare:null", "publish:null",
    "read:resumes/Readable--resume.json", "write:resumes/Readable--resume.json", "read:resumes/Readable--resume.json",
  ]);
  const published = JSON.parse(state.repository.manifestText!) as ManifestV2;
  assert.equal(published.entries[item.id].objectPath, objectPath(item.id, hash));
  assert.equal(published.entries[item.id].mirrorPath, "resumes/Readable--resume.json");
});

for (const scenario of ["content update", "title rename", "deletion"] as const) {
  test(`${scenario} manifest CAS failure preserves old manifest/object and performs no mirror mutation`, async () => {
    const old = resume("resume-full-id", "Old", "2026-09-13T01:00:00.000Z");
    const oldEntry = await entryFor(old, "resumes/Old--resume.json");
    const remote = await manifest({ [old.id]: oldEntry }, old.id);
    const plan = emptyPlan();
    let local = data(old);
    if (scenario === "deletion") {
      local = data();
      plan.trashMoves = [{
        resumeId: old.id,
        from: oldEntry.mirrorPath,
        to: "trash/Old--resume.json",
      }];
    } else {
      const changed = resume(old.id, scenario === "title rename" ? "New" : "Old", "2026-09-13T02:00:00.000Z");
      local = data(changed);
      plan.uploads = [{
        resume: changed,
        mirrorPath: scenario === "title rename" ? "resumes/New--resume.json" : oldEntry.mirrorPath,
        previousMirrorPath: scenario === "title rename" ? oldEntry.mirrorPath : null,
      }];
    }
    const state = setup({ local, remote, plan });
    seed(state.repository, oldEntry.objectPath, old);
    seed(state.repository, oldEntry.mirrorPath, old);
    const oldManifestText = state.repository.manifestText;
    state.repository.failPublish = true;

    assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-changed" });

    assert.equal(state.repository.manifestText, oldManifestText);
    assert.deepEqual(JSON.parse(state.repository.files.get(oldEntry.objectPath)!.text), old);
    const publishIndex = state.repository.calls.findIndex((call) => call.startsWith("publish:"));
    assert.equal(state.repository.calls.slice(0, publishIndex).some(
      (call) => call.startsWith("write:resumes/") || call.startsWith("write:trash/") || call.startsWith("move:"),
    ), false);
    assert.equal(state.repository.calls.slice(publishIndex + 1).some(
      (call) => call.startsWith("write:resumes/") || call.startsWith("write:trash/") || call.startsWith("move:"),
    ), false);
  });
}

test("downloads from immutable objectPath, not the readable mirror", async () => {
  const cloud = resume("cloud", "Cloud");
  const entry = await entryFor(cloud, "resumes/Human name--cloud.json");
  const remote = await manifest({ cloud: entry }, "cloud");
  const plan = emptyPlan();
  plan.downloads = [{ resumeId: cloud.id, objectPath: entry.objectPath, contentHash: entry.contentHash }];
  plan.nextActiveResumeId = cloud.id;
  const state = setup({ remote, plan });
  seed(state.repository, entry.objectPath, cloud);
  seed(state.repository, entry.mirrorPath, resume("cloud", "Tampered mirror"));

  const result = await executeSyncPlan(state.input);

  assert.equal(result.kind, "applied");
  assert.deepEqual(state.commits[0].data, data(cloud));
  assert.equal(state.repository.calls.includes(`read:${entry.mirrorPath}`), false);
});

test("mirror failure after manifest publication does not invalidate source of truth or local commit", async () => {
  const item = resume("a", "Readable");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Readable--a.json", previousMirrorPath: null }];
  plan.nextActiveResumeId = item.id;
  const state = setup({ local: data(item), plan });
  state.repository.failMirror = true;

  const result = await executeSyncPlan(state.input);

  assert.equal(result.kind, "applied");
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), true);
  assert.equal(state.commits.length, 1);
});

test("a later no-op repairs a missing readable mirror from immutable source", async () => {
  const item = resume("a", "Readable");
  const entry = await entryFor(item, "resumes/Readable--a.json");
  const remote = await manifest({ a: entry }, "a");
  const state = setup({ local: data(item), remote });
  state.input.plan.nextActiveResumeId = "a";
  seed(state.repository, entry.objectPath, item);

  await executeSyncPlan(state.input);

  assert.equal(state.repository.files.has(entry.mirrorPath), true);
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
});

test("local change after immutable object write prevents manifest publication and leaves only a safe orphan", async () => {
  const item = resume("local-race");
  const hash = await calculateResumeHash(item);
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Local--local-.json", previousMirrorPath: null }];
  plan.nextActiveResumeId = item.id;
  const state = setup({ local: data(item), plan });
  state.repository.onWrite = (path) => {
    if (path.startsWith("objects/")) state.setLocalToken("changed-during-upload");
  };

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.manifestText, null);
  assert.equal(state.repository.files.has(objectPath(item.id, hash)), true);
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
  assert.equal(state.repository.calls.some((call) => call.startsWith("write:resumes/")), false);
});


test("validates every live immutable object before publishing the final manifest", async () => {
  const existing = resume("existing");
  const existingEntry = await entryFor(existing);
  const remote = await manifest({ existing: existingEntry }, "existing");
  const added = resume("added");
  const plan = emptyPlan();
  plan.uploads = [{ resume: added, mirrorPath: "resumes/Added--added.json", previousMirrorPath: null }];
  plan.nextActiveResumeId = "existing";
  const missing = setup({ local: data(existing, added), remote, plan });

  assert.deepEqual(await executeSyncPlan(missing.input), { kind: "deferred", reason: "remote-changed" });
  assert.equal(missing.repository.calls.some((call) => call.startsWith("publish:")), false);

  const corrupt = setup({ local: data(existing, added), remote, plan });
  corrupt.repository.files.set(existingEntry.objectPath, { text: "{broken", etag: '"bad"' });
  await assert.rejects(executeSyncPlan(corrupt.input), (error: unknown) =>
    error instanceof WebDavError && error.code === "REMOTE_CONTENT_MISMATCH");
  assert.equal(corrupt.repository.calls.some((call) => call.startsWith("publish:")), false);
});

test("local change after publication subscription but before request prevents manifest publication", async () => {
  const item = resume("before-request");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Before--before.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  state.input.subscribeLocalToken = (listener: () => void) => {
    state.setLocalToken("changed-before-request");
    listener();
    return () => undefined;
  };

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
});

test("abort while manifest OPTIONS is pending prevents temp preparation and publication", async () => {
  const item = resume("abort-during-options");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Abort--abort-.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  const controller = new AbortController();
  const abortReason = new Error("stop during OPTIONS");
  let releaseOptions!: () => void;
  let markOptionsStarted!: () => void;
  const optionsPending = new Promise<void>((resolve) => { releaseOptions = resolve; });
  const optionsStarted = new Promise<void>((resolve) => { markOptionsStarted = resolve; });
  state.input.signal = controller.signal;
  state.repository.onCapabilityCheck = async () => {
    markOptionsStarted();
    await optionsPending;
  };

  const execution = executeSyncPlan(state.input);
  await optionsStarted;
  controller.abort(abortReason);
  releaseOptions();

  await assert.rejects(execution, (error: unknown) => error === abortReason);
  assert.equal(state.repository.manifestText, null);
  assert.equal(state.repository.temporarySourceExists, false);
  assert.equal(state.commits.length, 0);
  assert.equal(state.getListenerCount(), 0);
  assert.equal(state.repository.calls.some((call) => call.startsWith("prepare:")), false);
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
  assert.equal(state.repository.calls.some((call) => call.startsWith("cancel-source:")), false);
});

test("abort after prepare unsubscribes and conditionally cleans temp while preserving abort reason", async () => {
  const item = resume("abort-after-prepare");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Abort--abort-.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  const controller = new AbortController();
  const abortReason = new Error("stop after prepare");
  state.input.signal = controller.signal;
  state.repository.onPrepare = () => controller.abort(abortReason);
  state.repository.cancelSourceError = new WebDavError("SERVER", 503);

  await assert.rejects(executeSyncPlan(state.input), (error: unknown) => error === abortReason);
  assert.equal(state.getListenerCount(), 0);
  assert.equal(state.repository.calls.includes('cancel-source:"temp-etag"'), true);
  assert.equal(state.repository.calls.some((call) => call.startsWith("publish:")), false);
});

test("in-flight local change waits for delayed publish success then conditionally deletes first-sync manifest", async () => {
  const item = resume("in-flight");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/In-flight--in-fli.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  state.repository.onPublish = async (signal) => {
    state.setLocalToken("changed-in-flight");
    await Promise.resolve();
    assert.equal(signal?.aborted, false);
  };

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.manifestText, null);
  assert.equal(state.repository.calls.includes('delete-manifest:"published"'), true);
});

test("uncertain MOVE is neutralized when conditional temp DELETE wins", async () => {
  const old = resume("same-id", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--same-i.json", previousMirrorPath: oldEntry.mirrorPath }];
  plan.nextActiveResumeId = old.id;
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  const original = state.repository.manifestText;
  state.repository.publishNetworkError = true;
  state.repository.deferredMove = "delete-wins";
  state.repository.deferredMoveAfterReads = 5;
  state.repository.onPublish = () => state.setLocalToken("changed-during-uncertain-publish");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.manifestText, original);
  assert.equal(state.repository.calls.includes('cancel-source:"temp-etag"'), true);
  assert.equal(state.repository.calls.filter((call) => call === "read-manifest").length, 0);

  for (let read = 0; read < 5; read += 1) await state.repository.readManifest();
  assert.equal(state.repository.lateMoveFailed, true);
  assert.equal(state.repository.manifestText, original);
});

test("uncertain MOVE that wins before temp DELETE is identified and restored", async () => {
  const old = resume("move-wins", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--move-w.json", previousMirrorPath: oldEntry.mirrorPath }];
  plan.nextActiveResumeId = old.id;
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  const original = state.repository.manifestText;
  state.repository.publishNetworkError = true;
  state.repository.deferredMove = "move-wins";
  state.repository.onPublish = () => state.setLocalToken("changed-in-flight");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "local-changed" });
  assert.equal(state.repository.manifestText, original);
  assert.equal(state.repository.calls.filter((call) => call === "read-manifest").length, 2);
  assert.equal(state.repository.calls.includes('publish:"published"'), true);
});

test("missing temp with previous destination remains remote-uncertain without polling proof", async () => {
  const old = resume("source-lost", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--source.json", previousMirrorPath: oldEntry.mirrorPath }];
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  state.repository.publishNetworkError = true;
  state.repository.deferredMove = "source-lost";
  state.repository.onPublish = () => state.setLocalToken("changed-in-flight");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-uncertain" });
  assert.equal(state.repository.calls.filter((call) => call === "read-manifest").length, 1);
});

test("temp DELETE precondition failure keeps a still-existing source remote-uncertain", async () => {
  const old = resume("etag-changed", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--etag-c.json", previousMirrorPath: oldEntry.mirrorPath }];
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  state.repository.publishNetworkError = true;
  state.repository.cancelSourceError = new WebDavError("REMOTE_CAS_MISMATCH", 412);
  state.repository.onPublish = () => state.setLocalToken("changed-in-flight");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-uncertain" });
  assert.equal(state.repository.temporarySourceExists, true);
  assert.equal(state.repository.calls.filter((call) => call === "read-manifest").length, 0);
});

test("uncertain restore MOVE retains its handle and reconciles to remote-uncertain", async () => {
  const old = resume("restore-uncertain", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--restor.json", previousMirrorPath: oldEntry.mirrorPath }];
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  state.repository.restoreNetworkError = true;
  state.repository.onPublish = () => state.setLocalToken("changed-in-flight");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-uncertain" });
  assert.equal(state.repository.calls.filter((call) => call === 'cancel-source:"temp-etag"').length, 1);
  assert.equal(state.repository.temporarySourceExists, false);
  const attempted = await parseManifest(state.repository.manifestText!);
  assert.notEqual(attempted.manifestHash, remote.manifestHash);
});

test("third-party manifest committed before uncertain MOVE recovery is never overwritten", async () => {
  const old = resume("third-party-id", "Old");
  const oldEntry = await entryFor(old);
  const remote = await manifest({ [old.id]: oldEntry }, old.id);
  const changed = resume(old.id, "Changed");
  const thirdParty = await createManifest({
    schemaVersion: 2, revision: 6, parentRevision: 5, updatedAt: NOW,
    deviceId: "third-party", activeResumeId: old.id, entries: { [old.id]: oldEntry },
  });
  const plan = emptyPlan();
  plan.uploads = [{ resume: changed, mirrorPath: "resumes/Changed--third-.json", previousMirrorPath: oldEntry.mirrorPath }];
  plan.nextActiveResumeId = old.id;
  const state = setup({ local: data(changed), remote, plan });
  seed(state.repository, oldEntry.objectPath, old);
  state.repository.publishNetworkError = true;
  state.repository.deferredMove = "third-party";
  state.repository.thirdPartyManifestText = serializeManifest(thirdParty);
  state.repository.onPublish = () => state.setLocalToken("changed-in-flight");

  assert.deepEqual(await executeSyncPlan(state.input), { kind: "deferred", reason: "remote-changed" });
  assert.equal(state.repository.manifestText, serializeManifest(thirdParty));
  assert.equal(state.repository.calls.includes('publish:"third-party"'), false);
});

test("executor forwards AbortSignal to object writes, moves, and mirror repair", async () => {
  const item = resume("signals");
  const plan = emptyPlan();
  plan.uploads = [{ resume: item, mirrorPath: "resumes/Signals--signal.json", previousMirrorPath: null }];
  const state = setup({ local: data(item), plan });
  const controller = new AbortController();
  state.input.signal = controller.signal;

  await executeSyncPlan(state.input);

  assert.equal(state.repository.seenSignals.length > 0, true);
  assert.equal(state.repository.seenSignals.every((signal) => signal === controller.signal || signal !== undefined), true);
  assert.equal(state.repository.seenSignals.includes(undefined), false);
});
