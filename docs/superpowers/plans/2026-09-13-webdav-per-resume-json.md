# Per-Resume WebDAV JSON Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the aggregate `magic-resume.json` WebDAV snapshot with a versioned `manifest.json` plus one import-compatible JSON file per resume.

**Architecture:** A shared resume codec produces the exact business payload used by manual JSON export and WebDAV. A strict manifest codec keeps all synchronization metadata outside resume files; a pure planner computes per-resume three-way merge actions, while a repository/executor performs atomic WebDAV operations and publishes the manifest last. Existing Zustand stores retain atomic local data/baseline commits, and the controller/UI expose conflicts at resume granularity.

**Tech Stack:** TypeScript, React 18, Zustand 4, TanStack Start, WebDAV over `fetch`, Node `tsx --test`, Testing Library, JSDOM, Vite, Cloudflare Workers.

## Global Constraints

- `/magic-resume/objects/<full-resume-id>/<content-hash>.json` is the immutable source of truth. Published objects MUST never be overwritten, moved, or deleted.
- `resumes/*.json` and `trash/*.json` are readable, repairable mirrors; they are updated only after manifest CAS succeeds.
- Every object and mirror JSON file MUST contain only a valid `ResumeData` payload accepted by the existing manual JSON import path.
- Resume files MUST NOT contain `schemaVersion`, `revision`, `parentRevision`, `deviceId`, `contentHash`, ETag, or `activeResumeId` synchronization metadata.
- Resume filenames MUST be `<safe-title>--<first-six-resume-id-characters>.json`; full resume ID remains the authoritative identity.
- Synchronization metadata MUST live in `/magic-resume/manifest.json` with `schemaVersion: 2`.
- Deleted resume files MUST move to `/magic-resume/trash/`; `trash/` files MUST NOT be auto-imported.
- The implementation MUST NOT migrate or read legacy `/magic-resume/magic-resume.json`.
- Remote writes MUST remain HTTPS-only except localhost development URLs.
- Resume and manifest writes MUST use temporary upload plus conditional `MOVE`; manifest publication MUST happen after all referenced files are available.
- Servers without reliable conditional write/CAS support MUST fail closed.
- Runtime errors MUST expose only safe `code` and optional HTTP `status`, never credentials, URL query strings, response bodies, or resume content.
- Existing browser-local credential persistence and configurable WebDAV root directory MUST remain unchanged.
- Every implementation task follows RED → GREEN → focused regression tests → commit.

---

## File Structure

### New production files

- `src/lib/webdav/resume-codec.ts` — canonical single-resume JSON serialization, strict parsing, hashing, safe filename/path generation.
- `src/lib/webdav/manifest.ts` — `ManifestV2` creation, strict validation, canonical hashing, path validation.
- `src/lib/webdav/repository.ts` — high-level WebDAV operations for manifest, resume files, directory scanning, atomic writes, rename, and trash moves.
- `src/lib/webdav/planner.ts` — pure per-resume three-way merge planner and conflict model.
- `src/lib/webdav/executor.ts` — ordered execution of plans and manifest-last publication.

### Modified production files

- `src/utils/export.ts` — reuse the shared resume codec for manual JSON export without changing exported data shape.
- `src/lib/webdav/types.ts` — replace aggregate snapshot-facing synchronization types with manifest, baseline, plan, and resume-conflict types.
- `src/lib/webdav/client.ts` — expose collection listing metadata needed by the repository while preserving request safety.
- `src/lib/webdav/coordinator.ts` — orchestrate repository inspection, planning, execution, conflict resolution, and atomic local commit.
- `src/lib/webdav/controller.ts` — carry resume-level conflicts through manual/automatic synchronization.
- `src/hooks/useWebDavSync.ts` — wire the new coordinator dependencies and preserve remote-apply suppression.
- `src/store/useResumeStore.ts` — persist the multi-file baseline and atomically commit resume data plus baseline.
- `src/store/useWebDavStore.ts` — update runtime conflict/status types; authoritative baseline remains in Resume Store.
- `src/components/settings/WebDavConflictDialog.tsx` — show the conflicting resume title and resolve only that resume.
- `src/components/settings/WebDavSection.tsx` — show synchronized resume count and explain per-resume JSON storage.
- `src/i18n/locales/en.json` — add per-resume synchronization and conflict copy.
- `src/i18n/locales/zh.json` — add matching Chinese copy.
- `README.md` — document `manifest.json`, `resumes/`, `trash/`, and import compatibility.
- `README.zh-CN.md` — document the same behavior in Chinese.

### New test files

- `tests/webdav-resume-codec.test.ts`
- `tests/webdav-manifest.test.ts`
- `tests/webdav-repository.test.ts`
- `tests/webdav-planner.test.ts`
- `tests/webdav-executor.test.ts`

### Modified test files

- `tests/webdav-client.test.ts`
- `tests/webdav-coordinator.test.ts`
- `tests/webdav-controller.test.ts`
- `tests/webdav-resume-store.test.ts`
- `tests/webdav-store.test.ts`
- `tests/webdav-ui-contract.test.ts`
- `tests/webdav-snapshot.test.ts` — retain tests for reusable canonicalization/validation only; remove assertions that require aggregate remote storage.

---

### Task 1: Shared Resume JSON Codec

**Files:**
- Create: `src/lib/webdav/resume-codec.ts`
- Modify: `src/utils/export.ts`
- Modify: `src/lib/webdav/snapshot.ts`
- Test: `tests/webdav-resume-codec.test.ts`
- Test: `tests/webdav-snapshot.test.ts`

**Interfaces:**
- Consumes: `ResumeData` from `src/types/resume.ts`; existing strict resume validator and canonical JSON ordering from `src/lib/webdav/snapshot.ts`; existing `getSafeFileName` behavior from `src/utils/export.ts`.
- Produces:
  - `serializeResumeJson(resume: ResumeData): string`
  - `parseResumeJson(text: string): ResumeData`
  - `calculateResumeHash(resume: ResumeData): Promise<string>`
  - `getResumeFileName(resume: ResumeData): string`
  - `getResumeRelativePath(resume: ResumeData): string`
  - `getTrashRelativePath(resume: ResumeData): string`

- [ ] **Step 1: Write failing codec compatibility tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateResumeHash,
  getResumeFileName,
  parseResumeJson,
  serializeResumeJson,
} from "../src/lib/webdav/resume-codec";

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
```

- [ ] **Step 2: Run the new test and confirm RED**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-resume-codec.test.ts
```

Expected: FAIL because `src/lib/webdav/resume-codec.ts` does not exist.

- [ ] **Step 3: Implement the codec with one canonicalization source**

```ts
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
```

Move reusable canonicalization and strict `ResumeData` assertion out of aggregate-snapshot-only code without weakening current validation. Export the safe filename helper from one module instead of copying its regular expression.

- [ ] **Step 4: Make manual export use the shared serialization**

Update `exportResumeAsJson` so the downloaded payload comes from `serializeResumeJson(resume)` while retaining the current manual filename behavior. Do not add the short ID to manual export filenames; only WebDAV paths use `getResumeFileName`.

- [ ] **Step 5: Run codec and existing import/export-adjacent tests**

Run:

```bash
corepack pnpm exec tsx --test tests/webdav-resume-codec.test.ts tests/webdav-snapshot.test.ts tests/resume-import.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/lib/webdav/resume-codec.ts src/lib/webdav/snapshot.ts src/utils/export.ts tests/webdav-resume-codec.test.ts tests/webdav-snapshot.test.ts
git commit -m "feat(webdav): share per-resume JSON codec"
```

---

### Task 2: Versioned Manifest Codec

**Files:**
- Create: `src/lib/webdav/manifest.ts`
- Modify: `src/lib/webdav/types.ts`
- Test: `tests/webdav-manifest.test.ts`

**Interfaces:**
- Consumes: `stableStringify` and `sha256` shared by Task 1.
- Produces:

```ts
export interface ResumeManifestEntry {
  objectPath: string;
  mirrorPath: string;
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

export async function createManifest(body: ManifestV2Body): Promise<ManifestV2>;
export async function parseManifest(text: string): Promise<ManifestV2>;
export function serializeManifest(manifest: ManifestV2): string;
```

- [ ] **Step 1: Write failing manifest validation tests**

Cover all of these exact cases:

```ts
test("accepts a valid v2 manifest and verifies its hash", async () => { /* valid body */ });
test("rejects schema versions other than 2", async () => { /* schemaVersion: 1 */ });
test("rejects an invalid immutable object path", async () => { /* objects/id/hash.json */ });
test("rejects path traversal in object or mirror paths", async () => { /* ../ */ });
test("rejects duplicate object or mirror paths", async () => { /* same path */ });
test("requires live mirrors under resumes and deleted mirrors under trash", async () => { /* mismatch */ });
test("rejects a missing or mismatched manifestHash", async () => { /* tamper */ });
test("rejects activeResumeId when it references a deleted or absent entry", async () => { /* bad id */ });
```

- [ ] **Step 2: Run the manifest test and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-manifest.test.ts
```

Expected: FAIL because manifest types and codec do not exist.

- [ ] **Step 3: Add exact manifest types and strict parser**

Implement own-property allowlists for both manifest and entry objects. Validate:

- finite non-negative integer revisions;
- valid ISO timestamps that round-trip through `new Date(value).toISOString()`;
- non-empty `deviceId` and 64-character lowercase SHA-256 hashes;
- safe relative POSIX `objectPath` and `mirrorPath` values with no empty, `.` or `..` segment;
- `objectPath === objects/<full-id>/<contentHash>.json`, plus unique object and mirror paths;
- mirror folder/delete-state consistency;
- computed hash equality before returning parsed data.

Do not silently normalize unknown keys before hash validation.

- [ ] **Step 4: Run manifest and snapshot validation tests**

```bash
corepack pnpm exec tsx --test tests/webdav-manifest.test.ts tests/webdav-snapshot.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/webdav/types.ts src/lib/webdav/manifest.ts tests/webdav-manifest.test.ts
git commit -m "feat(webdav): add strict manifest v2 codec"
```

---

### Task 3: WebDAV Repository for Atomic Multi-File Operations

**Files:**
- Create: `src/lib/webdav/repository.ts`
- Modify: `src/lib/webdav/client.ts`
- Test: `tests/webdav-client.test.ts`
- Test: `tests/webdav-repository.test.ts`

**Interfaces:**
- Consumes: `WebDavClient`, `ManifestV2`, resume codec paths and parsers.
- Produces:

```ts
export interface RemoteTextFile {
  path: string;
  text: string;
  etag: string | null;
}

export interface RemoteResumeCandidate {
  path: string;
  etag: string | null;
}

export class WebDavResumeRepository {
  ensureLayout(): Promise<void>; // root + objects/ + resumes/ + trash/
  ensureObjectDirectory(resumeId: string): Promise<void>;
  readManifest(): Promise<RemoteTextFile | null>;
  readResume(path: string): Promise<RemoteTextFile | null>;
  listResumeCandidates(): Promise<RemoteResumeCandidate[]>;
  writeResumeAtomic(path: string, text: string, expectedEtag?: string | null): Promise<void>;
  moveResumeAtomic(from: string, to: string, expectedEtag: string | null): Promise<void>;
  prepareManifestPublish(text: string, expectedEtag: string | null): Promise<ManifestPublishOperation>;
  commitManifestPublish(operation: ManifestPublishOperation): Promise<void>;
  cancelManifestPublish(operation: ManifestPublishOperation): Promise<void>;
}
```

- [ ] **Step 1: Add failing client listing tests**

Extend `tests/webdav-client.test.ts` to prove `PROPFIND Depth: 1`:

- returns only direct child files;
- extracts decoded relative paths and ETags;
- rejects responses containing paths outside the requested collection;
- never forwards base URL query or credentials into `Destination`.

- [ ] **Step 2: Add failing repository sequence tests**

Use a fake client call log and assert exact order:

```ts
assert.deepEqual(calls, [
  ["ensureDirectory", "/magic-resume/"],
  ["ensureDirectory", "/magic-resume/objects/"],
  ["ensureDirectory", "/magic-resume/resumes/"],
  ["ensureDirectory", "/magic-resume/trash/"],
]);
```

Also assert:

- `writeResumeAtomic` PUTs a unique temporary sibling then MOVEs to the final path;
- failed MOVE attempts cleanup without hiding the primary safe error;
- manifest publish exposes a per-operation temporary source path and ETag before MOVE, probes OPTIONS for WebDAV class 1 plus MOVE/DELETE support, sends tagged source and destination conditions on MOVE, and can conditionally delete only that source after an uncertain MOVE;
- `listResumeCandidates` excludes directories, non-JSON files, temporary files, and every `trash/` file.

- [ ] **Step 3: Run client/repository tests and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-client.test.ts tests/webdav-repository.test.ts
```

Expected: new listing and repository assertions FAIL.

- [ ] **Step 4: Implement bounded collection listing and repository methods**

Reuse existing URL segment encoding, abort timeout, safe error mapping, and conditional PUT/MOVE behavior. Temporary names MUST be deterministic enough to test but unique per operation, for example:

```ts
const tempPath = `${finalPath}.tmp-${deviceId}-${operationId}`;
```

The repository must accept already-normalized relative paths from the manifest codec and must never concatenate unvalidated user strings into request URLs.

- [ ] **Step 5: Run focused protocol tests**

```bash
corepack pnpm exec tsx --test tests/webdav-client.test.ts tests/webdav-repository.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/lib/webdav/client.ts src/lib/webdav/repository.ts tests/webdav-client.test.ts tests/webdav-repository.test.ts
git commit -m "feat(webdav): add atomic resume repository"
```

---

### Task 4: Pure Per-Resume Three-Way Sync Planner

**Files:**
- Create: `src/lib/webdav/planner.ts`
- Modify: `src/lib/webdav/types.ts`
- Test: `tests/webdav-planner.test.ts`

**Interfaces:**
- Consumes: `ResumeData`, `ManifestV2`, content hashes, previous multi-file baseline.
- Produces:

```ts
export interface MultiFileBaselineEntry {
  contentHash: string;
  deleted: boolean;
  objectPath: string;
  mirrorPath: string;
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
  localUpdatedAt: string | null;
  remoteUpdatedAt: string | null;
  local: ResumeData | null;
  remoteEntry: ResumeManifestEntry | null;
}

export interface SyncPlan {
  uploads: Array<{ resume: ResumeData; mirrorPath: string; previousMirrorPath: string | null }>;
  downloads: Array<{ resumeId: string; objectPath: string; contentHash: string }>;
  trashMoves: Array<{ resumeId: string; from: string; to: string }>;
  remoteDeletions: string[];
  conflicts: ResumeSyncConflict[];
  nextActiveResumeId: string | null;
}

export function planSync(input: PlanSyncInput): SyncPlan;
```

- [ ] **Step 1: Write the complete decision-table tests before implementation**

Create one named test for each decision:

- no baseline + local resume + empty remote → upload;
- no baseline + remote resume + empty local → download;
- only local changed → upload;
- only remote changed → download;
- both changed to the same hash → no conflict;
- both changed to different hashes → `both-modified` conflict;
- local deletes unchanged remote → trash move;
- remote deletes unchanged local → local deletion;
- local deletes changed remote → `delete-vs-modify` conflict;
- remote deletes changed local → `delete-vs-modify` conflict;
- device A modifies resume 1 while device B modifies resume 2 → upload one and download one with no conflict;
- title-only change → retain immutable object identity and update `mirrorPath` / `previousMirrorPath` after manifest publish;
- every conflict records local/remote timestamps; hard deletion uses `manifest.updatedAt`;
- invalid active ID → deterministic first live resume or `null`.

- [ ] **Step 2: Run planner tests and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-planner.test.ts
```

Expected: FAIL because planner and baseline types do not exist.

- [ ] **Step 3: Implement planner as a side-effect-free ID-keyed comparison**

Use hashes, never timestamps, to determine content equality. Timestamps remain display/diagnostic metadata only. Build the union of local IDs, remote entry IDs, and baseline IDs; classify each independently. Sort all output arrays by full resume ID so execution and tests are deterministic.

- [ ] **Step 4: Run planner tests**

```bash
corepack pnpm exec tsx --test tests/webdav-planner.test.ts
```

Expected: all planner tests PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/lib/webdav/types.ts src/lib/webdav/planner.ts tests/webdav-planner.test.ts
git commit -m "feat(webdav): plan per-resume three-way sync"
```

---

### Task 5: Atomic Local Multi-File Baseline

**Files:**
- Modify: `src/store/useResumeStore.ts`
- Modify: `src/store/resumeHistory.ts`
- Modify: `src/store/useWebDavStore.ts`
- Test: `tests/webdav-resume-store.test.ts`
- Test: `tests/webdav-store.test.ts`

**Interfaces:**
- Consumes: `MultiFileBaseline`, `ResumeSyncData`.
- Produces:

```ts
getWebDavBaseline(): MultiFileBaseline | null;
commitWebDavSync(input: {
  data: ResumeSyncData;
  baseline: MultiFileBaseline;
  expectedLocalToken: string;
}): boolean;
clearWebDavBaseline(): void;
```

`commitWebDavSync` returns `false` without mutation when the current canonical local token differs from `expectedLocalToken`.

- [ ] **Step 1: Replace aggregate-baseline fixtures with multi-file fixtures**

Add RED tests proving:

- persist/rehydrate preserves every baseline entry;
- malformed persisted baseline is discarded without discarding resumes;
- resume data and baseline update in one Zustand `set` call;
- expected-token mismatch leaves both data and baseline unchanged;
- `clearCredentials` clears the authoritative baseline and runtime conflict but not resume data;
- `_isApplyingSyncSnapshot` is restored in `finally` when a subscriber throws.

- [ ] **Step 2: Run store tests and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-resume-store.test.ts tests/webdav-store.test.ts
```

Expected: aggregate baseline assumptions or missing new APIs cause FAIL.

- [ ] **Step 3: Implement versioned persisted-state migration**

Increment the Resume Store persistence version. Migrate prior aggregate WebDAV baseline to `null` because this feature explicitly does not migrate the old remote protocol. Preserve all resume data. Validate the multi-file baseline before exposing it to synchronization code.

- [ ] **Step 4: Implement atomic commit and cleanup APIs**

Keep the authoritative baseline in `useResumeStore`; `useWebDavStore` stores only settings and runtime state. Ensure no coordinator path can update resume data and baseline through two separate store writes.

- [ ] **Step 5: Run focused store tests**

```bash
corepack pnpm exec tsx --test tests/webdav-resume-store.test.ts tests/webdav-store.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/store/useResumeStore.ts src/store/resumeHistory.ts src/store/useWebDavStore.ts tests/webdav-resume-store.test.ts tests/webdav-store.test.ts
git commit -m "feat(webdav): persist per-resume sync baseline"
```

---

### Task 6: Manifest-Last Executor and Coordinator Integration

**Files:**
- Create: `src/lib/webdav/executor.ts`
- Modify: `src/lib/webdav/coordinator.ts`
- Modify: `src/lib/webdav/errors.ts`
- Test: `tests/webdav-executor.test.ts`
- Test: `tests/webdav-coordinator.test.ts`

**Interfaces:**
- Consumes: `SyncPlan`, `WebDavResumeRepository`, resume/manifest codecs, Store atomic commit callback.
- Produces:

```ts
export type ExecutePlanResult =
  | { kind: "applied"; data: ResumeSyncData; baseline: MultiFileBaseline; syncedCount: number }
  | { kind: "conflict"; conflicts: ResumeSyncConflict[] }
  | { kind: "deferred"; reason: "local-changed" | "remote-changed" | "remote-uncertain" };

export async function executeSyncPlan(input: ExecuteSyncPlanInput): Promise<ExecutePlanResult>;
```

Coordinator public methods remain compatible with the controller:

```ts
inspect(): Promise<SyncInspection>;
execute(decision?: ConflictDecision): Promise<SyncResult>;
```

Conflict decisions become resume-scoped:

```ts
type ConflictDecision = {
  resumeId: string;
  resolution: "keep-local" | "use-cloud";
  seenRemoteEtag: string | null;
  seenManifestRevision: number;
};
```

- [ ] **Step 1: Write failing executor ordering and failure tests**

Assert exact safety properties:

- initial local expected-token mismatch is checked before `ensureLayout` and causes zero repository calls;
- directories, including `objects/`, are ensured before object writes;
- every new immutable object is created and hash-verified before manifest publication;
- immediately before publication, every live entry in the final manifest is reread and strictly checked for existence, valid `ResumeData`, full ID, and content hash;
- publication subscription and prepared temp source are scoped by `try/finally`; abort after prepare but before MOVE unsubscribes and conditionally deletes the temp source without replacing the original abort reason;
- after an issued publish succeeds with a local change, confirm the current remote hash is the attempted manifest and CAS-restore the old manifest, or conditionally delete it for first sync;
- initial and restoration manifest MOVEs share `commitPreparedManifestWithReconciliation`: on NETWORK/TIMEOUT, conditionally DELETE the exact temporary source by source ETag; DELETE success proves the late MOVE cannot commit, only 404 permits destination classification, and 412/423 stays `remote-uncertain` because the source may still exist; classify destination as before, after, or third-party, never overwrite third-party, and never treat repeated immediate GETs as terminal-state proof;
- upload/object failure means no manifest publication operation is prepared or committed;
- downloaded content is read from `objectPath`, parsed, and hash-verified before entering result data;
- manifest CAS mismatch returns `deferred: remote-changed` and performs no mirror mutation;
- only after manifest CAS succeeds may `resumes/` and `trash/` mirrors be written/moved;
- mirror failure does not invalidate the authoritative manifest and is repaired by a later sync;
- every executor repository operation propagates its caller signal, including object PUT/MOVE and mirror repair;
- general WebDAV DELETE rejects every non-2xx response; only repository temporary-file cleanup catches it best-effort;
- conflict decisions require both `seenRemoteEtag` (including explicit `null`) and `seenManifestRevision`; missing or stale fields defer before application.

- [ ] **Step 2: Rewrite coordinator tests around per-resume outcomes**

Remove assertions that require a single `magic-resume.json`. Preserve equivalent safety coverage for:

- first sync from local-only data;
- cloud-only bootstrap;
- no-op sync;
- upload/download;
- both-modified conflict;
- delete-vs-modify conflict;
- keep-local and use-cloud resolutions;
- local/remote CAS races;
- error sanitization.

- [ ] **Step 3: Run executor/coordinator tests and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-executor.test.ts tests/webdav-coordinator.test.ts
```

Expected: FAIL until aggregate coordinator logic is replaced.

- [ ] **Step 4: Implement initial-manifest and ordinary execution paths**

For an empty remote:

1. ensure layout;
2. atomically upload each local resume;
3. create manifest revision 1 with `parentRevision: null`;
4. publish with create-only precondition;
5. atomically commit the returned local baseline.

For an existing remote, execute the sorted plan. Keep bounded CAS retries in the coordinator; each retry must reread manifest and replan.

- [ ] **Step 5: Implement unindexed manual JSON discovery**

After reading a valid manifest, scan `resumes/` only. For every path absent from manifest:

1. read text;
2. strictly parse `ResumeData`;
3. compute hash;
4. group unindexed files by full ID and sort paths deterministically;
5. deduplicate equal hashes, but emit a safe ambiguity warning and import nothing for an ID with differing hashes;
6. treat a new full ID as a remote addition;
7. treat an existing ID with a different unambiguous hash as a remote modification/conflict;
8. surface only safe warning codes for invalid files.

Never scan or import `trash/`.

- [ ] **Step 6: Run all core synchronization tests**

```bash
corepack pnpm exec tsx --test tests/webdav-resume-codec.test.ts tests/webdav-manifest.test.ts tests/webdav-repository.test.ts tests/webdav-planner.test.ts tests/webdav-executor.test.ts tests/webdav-coordinator.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/lib/webdav/executor.ts src/lib/webdav/coordinator.ts src/lib/webdav/errors.ts tests/webdav-executor.test.ts tests/webdav-coordinator.test.ts
git commit -m "feat(webdav): execute manifest-first resume sync"
```

---

### Task 7: Controller, Hook, and Resume-Level Conflict UI

**Files:**
- Modify: `src/lib/webdav/controller.ts`
- Modify: `src/hooks/useWebDavSync.ts`
- Modify: `src/store/useWebDavStore.ts`
- Modify: `src/components/settings/WebDavConflictDialog.tsx`
- Modify: `src/components/settings/WebDavSection.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh.json`
- Test: `tests/webdav-controller.test.ts`
- Test: `tests/webdav-ui-contract.test.ts`

**Interfaces:**
- Consumes: resume-scoped `ResumeSyncConflict`, `ConflictDecision`, and `syncedCount` from Task 6.
- Produces:

```ts
resolveConflict(resumeId: string, resolution: "keep-local" | "use-cloud"): Promise<void>;
```

Runtime state includes:

```ts
conflicts: ResumeSyncConflict[];
syncedResumeCount: number;
lastSyncedAt: string | null;
```

- [ ] **Step 1: Add failing controller behavior tests**

Prove:

- automatic synchronization pauses while unresolved conflicts exist;
- resolving one conflict removes only that resume's conflict;
- unrelated pending conflicts remain visible;
- resolution runs inside the existing single-flight queue;
- edits made during conflict resolution trigger one dirty follow-up;
- offline and visibility behavior remains unchanged;
- successful no-op and applied sync update count/time without exposing private data.

- [ ] **Step 2: Add failing real DOM tests**

Render the actual settings section and dialog under JSDOM. Assert:

```ts
assert.match(screen.getByText("产品经理简历").textContent ?? "", /产品经理简历/);
await user.click(screen.getByRole("button", { name: "保留本地版本" }));
assert.deepEqual(resolveCalls, [{ resumeId: "full-id", resolution: "keep-local" }]);
```

Also verify:

- “共同步 3 份简历” appears;
- per-resume JSON explanatory copy appears;
- keyboard Escape does not silently discard an unresolved conflict;
- password is not rendered in status/error text;
- English locale has the same keys as Chinese.

- [ ] **Step 3: Run controller/UI tests and confirm RED**

```bash
corepack pnpm exec tsx --test tests/webdav-controller.test.ts tests/webdav-ui-contract.test.ts
```

Expected: current whole-snapshot conflict state causes FAIL.

- [ ] **Step 4: Wire resume-level resolution through controller and hook**

Preserve single-flight, debounce, offline, visibility, hydration, and remote-apply suppression semantics. Do not create a second controller instance during React rerenders. Clear a conflict only after its resolution completes successfully or returns a newer replacement conflict.

- [ ] **Step 5: Update settings UI and translations**

Use existing Dialog primitives and accessible labels. Add concise copy explaining:

- one JSON file per resume;
- files are directly importable;
- credentials remain browser-local;
- clearing credentials does not delete WebDAV files.

- [ ] **Step 6: Run focused and full WebDAV suites**

```bash
corepack pnpm exec tsx --test tests/webdav-controller.test.ts tests/webdav-ui-contract.test.ts
corepack pnpm test:webdav
```

Expected: both commands PASS with zero failed tests.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/lib/webdav/controller.ts src/hooks/useWebDavSync.ts src/store/useWebDavStore.ts src/components/settings/WebDavConflictDialog.tsx src/components/settings/WebDavSection.tsx src/i18n/locales/en.json src/i18n/locales/zh.json tests/webdav-controller.test.ts tests/webdav-ui-contract.test.ts
git commit -m "feat(webdav): resolve conflicts per resume"
```

---

### Task 8: Documentation, Final Regression, and Cloudflare Deployment

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `package.json` only if a focused test script is added; do not add runtime dependencies.

**Interfaces:**
- Consumes: completed schema v2 implementation and deployed Cloudflare Worker configuration.
- Produces: user-facing storage documentation and verified production deployment.

- [ ] **Step 1: Update bilingual documentation**

Document this exact structure:

```text
<remote-root>/
├── manifest.json
├── objects/<full-resume-id>/<content-hash>.json
├── resumes/<safe-title>--<short-id>.json
└── trash/<safe-title>--<short-id>.json
```

State that resume files match manual export format and can be imported individually. State that files are plaintext JSON protected in transit by HTTPS, recommend a dedicated least-privilege WebDAV account, and clarify that clearing credentials does not remove remote files.

- [ ] **Step 2: Run formatting/diff hygiene**

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run the complete WebDAV suite**

```bash
corepack pnpm test:webdav
```

Expected: zero failed, cancelled, or skipped tests unless a skip already existed before this feature.

- [ ] **Step 4: Run adjacent regression suites**

```bash
corepack pnpm test:ai
corepack pnpm test:resume-import
```

Expected: both commands exit 0. Existing test log warnings that intentionally exercise upstream failures are acceptable; assertion failures are not.

- [ ] **Step 5: Build the production Worker bundle**

```bash
corepack pnpm build
```

Expected: exit code 0 and generated `dist/client` plus `dist/server/server.js`. Existing bundle-size or side-effect warnings may be reported but must not be introduced as errors.

- [ ] **Step 6: Commit documentation and final cleanup**

```bash
git add README.md README.zh-CN.md package.json pnpm-lock.yaml
git commit -m "docs(webdav): explain per-resume storage"
```

Only stage `package.json` and `pnpm-lock.yaml` if they actually changed.

- [ ] **Step 7: Push the verified branch to the user's fork main**

```bash
git push fork HEAD:main
```

Expected: fast-forward update of `aurostars/magic-resume` main. Do not force-push.

- [ ] **Step 8: Deploy the verified build to Cloudflare Workers**

```bash
corepack pnpm exec wrangler deploy
```

Expected: deployment URL remains `https://magic-resume.3056728260.workers.dev` and Wrangler reports a new version ID.

- [ ] **Step 9: Verify production behavior**

Verify all of the following against the deployed URL:

- `/` loads and redirects/localizes correctly;
- `/app/dashboard/settings` renders the WebDAV section;
- the page explains per-resume JSON storage;
- configuring an authorized disposable WebDAV test directory creates `manifest.json`, `resumes/`, and `trash/`;
- downloading one `resumes/*.json` and importing it through the site succeeds;
- deleting that test resume moves its remote file into `trash/`;
- browser console has no new runtime errors.

Do not use a user's production WebDAV directory for destructive verification unless they explicitly provide a disposable directory.

---

## Final Self-Review Checklist

- Every design requirement maps to at least one task above.
- Resume JSON format compatibility is implemented in Task 1 and verified again in Task 8.
- Filename rules are implemented and tested in Task 1.
- Strict manifest validation and hash integrity are implemented in Task 2.
- Atomic multi-file operations and directory scanning are implemented in Task 3.
- Per-resume three-way merge and conflict semantics are implemented in Task 4.
- Local data/baseline atomicity is implemented in Task 5.
- Manifest-last execution, first sync, orphan/manual import, and CAS retry are implemented in Task 6.
- Resume-scoped UX and controller behavior are implemented in Task 7.
- Documentation, complete regression tests, build, push, deployment, and production checks are implemented in Task 8.
- No task reads or migrates legacy `magic-resume.json`.
- No task introduces D1, R2, KV, account storage, or a runtime dependency.
