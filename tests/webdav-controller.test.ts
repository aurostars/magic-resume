import assert from "node:assert/strict";
import test, { after } from "node:test";
import { initialResumeState } from "../src/config/initialResumeData";
import type { WebDavClientApi } from "../src/lib/webdav/client";
import {
  LocalCasMismatchError,
  type SyncExecuteResult,
  type SyncInspection,
} from "../src/lib/webdav/coordinator";
import {
  FOREGROUND_MIN_INTERVAL_MS,
  LOCAL_DEBOUNCE_MS,
  WebDavSyncController,
  type SyncControllerClock,
  type SyncControllerState,
} from "../src/lib/webdav/controller";
import {
  calculateContentHash,
  canonicalizeSyncData,
  createCloudSnapshot,
} from "../src/lib/webdav/snapshot";
import { createManifest, serializeManifest } from "../src/lib/webdav/manifest";
import { calculateResumeHash, serializeResumeJson } from "../src/lib/webdav/resume-codec";
import type { CloudSnapshotV1, ManifestV2, MultiFileBaseline } from "../src/lib/webdav/types";
import { useResumeStore } from "../src/store/useResumeStore";
import { useWebDavStore, type WebDavConflict } from "../src/store/useWebDavStore";
import {
  attachWebDavLifecycle,
  commitDownloadedSnapshot,
  createConfiguredController,
  getWebDavSyncController,
} from "../src/hooks/useWebDavSync";

const localStorageData = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() { return localStorageData.size; },
    clear: () => localStorageData.clear(),
    getItem: (key: string) => localStorageData.get(key) ?? null,
    key: (index: number) => [...localStorageData.keys()][index] ?? null,
    removeItem: (key: string) => { localStorageData.delete(key); },
    setItem: (key: string, value: string) => { localStorageData.set(key, value); },
  } satisfies Storage,
});
const originalConsoleWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const message = String(args[0]);
  if (
    message.startsWith("[resume-store] Failed to persist") ||
    message.startsWith("[zustand persist middleware] Unable to update item 'webdav-sync-storage'")
  ) return;
  originalConsoleWarn(...args);
};
after(() => { console.warn = originalConsoleWarn; });

const completed = { status: "unchanged", warning: null } as const;
const cloud = {
  schemaVersion: 1,
  revision: "cloud-r2",
  parentRevision: "r1",
  updatedAt: "2026-09-12T12:00:00.000Z",
  deviceId: "cloud-device",
  contentHash: "hash",
  data: { resumes: [], activeResumeId: null },
} satisfies CloudSnapshotV1;
const conflict: WebDavConflict = {
  local: { updatedAt: "2026-09-12T13:00:00.000Z", deviceId: "local-device", resumeCount: 1 },
  cloud: { updatedAt: cloud.updatedAt, deviceId: cloud.deviceId, resumeCount: 0 },
  snapshot: cloud,
  remoteEtag: '"etag-cloud-r2"',
  manifestRevision: 2,
};
const conflictResult = {
  decision: "conflict",
  cloud,
  remoteEtag: '"etag-cloud-r2"',
  localData: { resumes: [], activeResumeId: null },
  localHash: "local-hash",
  localToken: "local-token",
} as const;

const conflictFromInspection = (
  inspection: Extract<SyncInspection, { decision: "conflict" }>,
): WebDavConflict => ({
  ...conflict,
  cloud: {
    ...conflict.cloud,
    updatedAt: inspection.cloud?.updatedAt ?? conflict.cloud.updatedAt,
    deviceId: inspection.cloud?.deviceId ?? conflict.cloud.deviceId,
  },
  snapshot: inspection.cloud ?? conflict.snapshot,
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

class FakeClock implements SyncControllerClock {
  private time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    this.timers.delete(timer as unknown as number);
  };
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await Promise.resolve();
    }
    this.time = target;
    await Promise.resolve();
  }
  pendingCount(): number { return this.timers.size; }
}

const setup = (overrides: {
  inspect?: (signal: AbortSignal) => Promise<SyncInspection>;
  execute?: (signal: AbortSignal) => Promise<SyncExecuteResult>;
  keepLocal?: (snapshot: CloudSnapshotV1, etag: string | null, revision: number, signal: AbortSignal) => Promise<SyncExecuteResult>;
  useCloud?: (snapshot: CloudSnapshotV1, etag: string | null, revision: number, signal: AbortSignal) => Promise<SyncExecuteResult>;
  options?: (path: string, signal?: AbortSignal) => Promise<void>;
  propfind?: (path: string, signal?: AbortSignal) => Promise<boolean>;
  begin?: () => void;
  createConflict?: (inspection: Extract<SyncInspection, { decision: "conflict" }>) => WebDavConflict;
  hydrated?: boolean;
  configured?: boolean;
  auto?: boolean;
  online?: boolean;
  visible?: boolean;
  conflicted?: boolean;
  remoteApply?: boolean;
} = {}) => {
  const clock = new FakeClock();
  const events: string[] = [];
  let calls = 0;
  let currentConflict: WebDavConflict | null = overrides.conflicted ? conflict : null;
  const flags = {
    hydrated: overrides.hydrated ?? true,
    configured: overrides.configured ?? true,
    auto: overrides.auto ?? true,
    online: overrides.online ?? true,
    visible: overrides.visible ?? true,
    remoteApply: overrides.remoteApply ?? false,
  };
  const state: SyncControllerState = {
    isConfigured: () => flags.configured,
    isHydrated: () => flags.hydrated,
    isAutoSyncEnabled: () => flags.auto,
    isOnline: () => flags.online,
    isVisible: () => flags.visible,
    hasConflict: () => currentConflict !== null,
    begin: () => { events.push("begin"); overrides.begin?.(); },
    complete: (warning) => events.push(`complete:${warning ?? "none"}`),
    defer: () => events.push("defer"),
    fail: () => events.push("fail"),
    setConflict: (next) => { currentConflict = next; events.push("conflict"); },
    clearConflict: () => { currentConflict = null; events.push("clear"); },
  };
  const methods: string[] = [];
  const client = {
    options: async (path: string, signal?: AbortSignal) => {
      methods.push(`OPTIONS ${path}`);
      await overrides.options?.(path, signal);
    },
    propfind: async (path: string, signal?: AbortSignal) => {
      methods.push(`PROPFIND ${path}`);
      return overrides.propfind ? overrides.propfind(path, signal) : true;
    },
  } as WebDavClientApi;
  const controller = new WebDavSyncController({
    clock,
    state,
    client,
    remoteDirectory: "/sync/",
    coordinator: {
      inspect: overrides.inspect ?? (async () => conflictResult),
      execute: async (signal) => {
        calls += 1;
        return overrides.execute ? overrides.execute(signal) : completed;
      },
      keepLocal: overrides.keepLocal ?? (async () => completed),
      useCloud: overrides.useCloud ?? (async () => completed),
    },
    createConflict: overrides.createConflict ?? (() => conflict),
    isApplyingRemote: () => flags.remoteApply,
  });
  return {
    clock, controller, events, methods, flags,
    calls: () => calls,
    hasConflict: () => currentConflict !== null,
    conflict: () => currentConflict,
  };
};

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("local changes coalesce and sync only after exactly five seconds", async () => {
  const s = setup({ auto: false });
  s.flags.auto = true;
  s.controller.notifyLocalChange();
  s.controller.notifyLocalChange();
  await s.clock.advance(LOCAL_DEBOUNCE_MS - 1);
  assert.equal(s.calls(), 0);
  await s.clock.advance(1);
  await s.controller.whenIdle();
  assert.equal(s.calls(), 1);
});

test("changes during a running sync produce exactly one follow-up", async () => {
  const first = deferred<SyncExecuteResult>();
  const s = setup({ auto: false, execute: async () => s.calls() === 1 ? first.promise : completed });
  const running = s.controller.syncNow("manual");
  s.controller.notifyLocalChange();
  s.controller.notifyLocalChange();
  first.resolve(completed);
  await running;
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2);
});

test("busy connection and resolution flights consume queued sync and dirty as one follow-up", async () => {
  const connection = deferred<void>();
  const testing = setup({ options: async () => connection.promise });
  const activeTest = testing.controller.testConnection();
  testing.controller.syncNow("manual");
  testing.controller.syncNow("manual");
  testing.controller.notifyLocalChange();
  testing.controller.notifyLocalChange();
  connection.resolve();
  await activeTest;
  await testing.controller.whenIdle();
  assert.equal(testing.calls(), 1, "testConnection");

  const resolution = deferred<SyncExecuteResult>();
  const resolving = setup({
    execute: async () => resolving.calls() === 1 ? conflictResult : completed,
    keepLocal: async () => resolution.promise,
  });
  await resolving.controller.syncNow("manual");
  const activeResolution = resolving.controller.resolveConflict("local");
  resolving.controller.syncNow("manual");
  resolving.controller.syncNow("manual");
  resolving.controller.notifyLocalChange();
  resolving.controller.notifyLocalChange();
  resolution.resolve(completed);
  await activeResolution;
  await resolving.controller.whenIdle();
  assert.equal(resolving.calls(), 2, "resolution");
});

test("a synchronous begin reentry observes the established single-flight lock", async () => {
  const first = deferred<SyncExecuteResult>();
  let reentered = false;
  let nested: Promise<void> | undefined;
  const s = setup({
    begin: () => {
      if (reentered) return;
      reentered = true;
      nested = s.controller.syncNow("manual");
    },
    execute: async () => first.promise,
  });

  const running = s.controller.syncNow("manual");
  assert.equal(s.calls(), 1);
  first.resolve(completed);
  await running;
  await nested;
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2);
});

test("sync queues resolution and connection checks without concurrent remote operations", async () => {
  const sync = deferred<SyncExecuteResult>();
  let resolutions = 0;
  const s = setup({
    execute: async () => s.calls() === 1 ? conflictResult : sync.promise,
    keepLocal: async () => { resolutions += 1; return completed; },
  });
  await s.controller.syncNow("manual");

  const running = s.controller.syncNow("manual");
  const resolving = s.controller.resolveConflict("local");
  const testing = s.controller.testConnection();
  await settle();
  assert.equal(resolutions, 0);
  assert.deepEqual(s.methods, []);

  sync.resolve(completed);
  await Promise.all([running, resolving, testing]);
  assert.equal(resolutions, 0);
  assert.deepEqual(s.methods, ["OPTIONS /sync/", "PROPFIND /sync/"]);
});

test("a manual sync requested during resolution runs after the write", async () => {
  const resolution = deferred<SyncExecuteResult>();
  const s = setup({
    execute: async () => s.calls() === 1 ? conflictResult : completed,
    keepLocal: async () => resolution.promise,
  });
  await s.controller.syncNow("manual");

  const resolving = s.controller.resolveConflict("local");
  const syncing = s.controller.syncNow("manual");
  assert.equal(s.calls(), 1);
  resolution.resolve(completed);
  await Promise.all([resolving, syncing]);
  assert.equal(s.calls(), 2);
});

test("duplicate conflict resolutions share the queue and never write concurrently", async () => {
  const resolution = deferred<SyncExecuteResult>();
  let resolutions = 0;
  const s = setup({
    execute: async () => conflictResult,
    keepLocal: async () => { resolutions += 1; return resolution.promise; },
  });
  await s.controller.syncNow("manual");

  const first = s.controller.resolveConflict("local");
  const second = s.controller.resolveConflict("local");
  await settle();
  assert.equal(resolutions, 1);
  resolution.resolve(completed);
  await Promise.all([first, second]);
  assert.equal(resolutions, 1);
});

test("offline dirty state waits and notifyOnline retries once", async () => {
  const s = setup({ auto: false, online: false });
  s.flags.auto = true;
  s.controller.notifyLocalChange();
  await s.clock.advance(LOCAL_DEBOUNCE_MS * 2);
  assert.equal(s.calls(), 0);
  s.flags.online = true;
  s.controller.notifyOnline();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 1);
});

test("foreground checks ignore hidden tabs and are limited to once per minute", async () => {
  const s = setup({ auto: false, visible: false });
  s.flags.auto = true;
  s.controller.notifyVisible();
  await settle();
  assert.equal(s.calls(), 0);
  s.flags.visible = true;
  s.controller.notifyVisible();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 1);
  s.controller.notifyVisible();
  await settle();
  assert.equal(s.calls(), 1);
  await s.clock.advance(FOREGROUND_MIN_INTERVAL_MS);
  s.controller.notifyVisible();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2);
});

test("automatic sync requires hydration, configuration and the auto setting", async () => {
  for (const blocked of ["hydrated", "configured", "auto"] as const) {
    const s = setup({ auto: false });
    s.flags.auto = true;
    s.flags[blocked] = false;
    s.controller.notifyLocalChange();
    await s.clock.advance(LOCAL_DEBOUNCE_MS);
    assert.equal(s.calls(), 0, blocked);
  }
});

test("startup does not sync before hydration", async () => {
  const s = setup({ hydrated: false });
  await settle();
  assert.equal(s.calls(), 0);
});

test("conflict and dismissal pause auto while manual sync still inspects", async () => {
  const s = setup({ auto: false, execute: async () => conflictResult });
  await s.controller.syncNow("manual");
  assert.equal(s.hasConflict(), true);
  s.controller.dismissConflict();
  s.flags.auto = true;
  s.controller.notifyLocalChange();
  await s.clock.advance(LOCAL_DEBOUNCE_MS);
  assert.equal(s.calls(), 1);
  await s.controller.syncNow("manual");
  assert.equal(s.calls(), 2);
  assert.equal(s.events.filter((event) => event === "conflict").length, 2);
});

test("a successful manual execute clears an old conflict and automatic sync resumes", async () => {
  const s = setup({
    auto: false,
    execute: async () => s.calls() === 1 ? conflictResult : completed,
  });
  await s.controller.syncNow("manual");
  assert.equal(s.hasConflict(), true);

  await s.controller.syncNow("manual");
  assert.equal(s.hasConflict(), false);

  s.flags.auto = true;
  s.controller.notifyLocalChange();
  await s.clock.advance(LOCAL_DEBOUNCE_MS);
  await s.controller.whenIdle();
  assert.equal(s.calls(), 3);
});

test("conflict choices call matching coordinator and clear only after success", async () => {
  const local = deferred<SyncExecuteResult>();
  const cloudChoice = deferred<SyncExecuteResult>();
  const methods: string[] = [];
  const freshness: Array<[string | null, number]> = [];
  const s = setup({
    auto: false,
    execute: async () => conflictResult,
    keepLocal: async (_snapshot, etag, revision) => {
      methods.push("local"); freshness.push([etag, revision]); return local.promise;
    },
    useCloud: async (_snapshot, etag, revision) => {
      methods.push("cloud"); freshness.push([etag, revision]); return cloudChoice.promise;
    },
  });
  await s.controller.syncNow("manual");
  const localRunning = s.controller.resolveConflict("local");
  assert.equal(s.hasConflict(), true);
  local.resolve(completed);
  await localRunning;
  assert.equal(s.hasConflict(), false);
  await s.controller.syncNow("manual");
  s.controller.dismissConflict();
  const cloudRunning = s.controller.resolveConflict("cloud");
  assert.equal(s.hasConflict(), true);
  cloudChoice.resolve(completed);
  await cloudRunning;
  assert.equal(s.hasConflict(), false);
  assert.deepEqual(methods, ["local", "cloud"]);
  assert.deepEqual(freshness, [['"etag-cloud-r2"', 2], ['"etag-cloud-r2"', 2]]);
});

test("a CAS conflict during cloud resolution remains surfaced", async () => {
  const s = setup({ auto: false, execute: async () => conflictResult, useCloud: async () => conflictResult });
  await s.controller.syncNow("manual");
  await s.controller.resolveConflict("cloud");
  assert.equal(s.hasConflict(), true);
  assert.equal(s.events.includes("clear"), false);
});

test("structured CAS conflicts from either resolution refresh the surfaced snapshot", async () => {
  const refreshedCloud = { ...cloud, revision: "cloud-r3" };
  const refreshed = { ...conflictResult, cloud: refreshedCloud, reason: "LOCAL_CAS_MISMATCH" as const };
  for (const choice of ["local", "cloud"] as const) {
    const s = setup({
      execute: async () => conflictResult,
      keepLocal: async () => refreshed,
      useCloud: async () => refreshed,
      createConflict: conflictFromInspection,
    });
    await s.controller.syncNow("manual");
    await s.controller.resolveConflict(choice);
    assert.equal(s.conflict()?.snapshot.revision, "cloud-r3", choice);
    assert.equal(s.events.includes("fail"), false, choice);
  }
});

test("LOCAL_CAS_MISMATCH errors from execute refresh the current conflict", async () => {
  const refreshedCloud = { ...cloud, revision: "cloud-r3" };
  const refreshed = { ...conflictResult, cloud: refreshedCloud, reason: "LOCAL_CAS_MISMATCH" as const };
  const s = setup({
    execute: async () => { throw new LocalCasMismatchError(); },
    inspect: async () => refreshed,
    createConflict: conflictFromInspection,
  });

  await s.controller.syncNow("manual");

  assert.equal(s.conflict()?.snapshot.revision, "cloud-r3");
  assert.equal(s.events.includes("fail"), false);
});

test("LOCAL_CAS_MISMATCH errors from both resolutions refresh the current conflict", async () => {
  const refreshedCloud = { ...cloud, revision: "cloud-r3" };
  const refreshed = { ...conflictResult, cloud: refreshedCloud, reason: "LOCAL_CAS_MISMATCH" as const };
  for (const choice of ["local", "cloud"] as const) {
    const s = setup({
      execute: async () => conflictResult,
      inspect: async () => refreshed,
      keepLocal: async () => { throw new LocalCasMismatchError(); },
      useCloud: async () => { throw new LocalCasMismatchError(); },
      createConflict: conflictFromInspection,
    });
    await s.controller.syncNow("manual");
    await s.controller.resolveConflict(choice);
    assert.equal(s.conflict()?.snapshot.revision, "cloud-r3", choice);
    assert.equal(s.events.includes("fail"), false, choice);
  }
});

test("remote apply notifications do not schedule an upload loop", async () => {
  const s = setup({ auto: false });
  s.flags.auto = true;
  s.flags.remoteApply = true;
  s.controller.notifyLocalChange();
  s.flags.remoteApply = false;
  await s.clock.advance(LOCAL_DEBOUNCE_MS);
  assert.equal(s.calls(), 0);
});

test("testConnection performs OPTIONS then PROPFIND", async () => {
  const s = setup({ auto: false });
  await s.controller.testConnection();
  assert.deepEqual(s.methods, ["OPTIONS /sync/", "PROPFIND /sync/"]);
});

test("testConnection reports failures through controller state", async () => {
  const failure = new Error("offline");
  const s = setup({ options: async () => { throw failure; } });

  await assert.rejects(() => s.controller.testConnection(), failure);

  assert.equal(s.events.includes("fail"), true);
  assert.deepEqual(s.methods, ["OPTIONS /sync/"]);
});

test("dispose clears a pending debounce and aborts an active request", async () => {
  const pending = setup({ auto: false });
  pending.flags.auto = true;
  pending.controller.notifyLocalChange();
  assert.equal(pending.clock.pendingCount(), 1);
  pending.controller.dispose();
  assert.equal(pending.clock.pendingCount(), 0);
  await pending.clock.advance(LOCAL_DEBOUNCE_MS);
  assert.equal(pending.calls(), 0);

  const active = deferred<SyncExecuteResult>();
  let signal: AbortSignal | undefined;
  const runningState = setup({ execute: async (nextSignal) => { signal = nextSignal; return active.promise; } });
  const running = runningState.controller.syncNow("manual");
  runningState.controller.dispose();
  assert.equal(signal?.aborted, true);
  active.resolve(completed);
  await running;
});

test("dispose blocks every later public asynchronous entry", async () => {
  let resolutions = 0;
  const s = setup({
    execute: async () => conflictResult,
    useCloud: async () => { resolutions += 1; return completed; },
  });
  await s.controller.syncNow("manual");
  const callsBeforeDispose = s.calls();
  s.controller.dispose();

  await Promise.all([
    s.controller.syncNow("manual"),
    s.controller.testConnection(),
    s.controller.resolveConflict("cloud"),
  ]);

  assert.equal(s.calls(), callsBeforeDispose);
  assert.equal(resolutions, 0);
  assert.deepEqual(s.methods, []);
});

test("cloud resolution owns the sole flight signal and dispose aborts it", async () => {
  const resolution = deferred<SyncExecuteResult>();
  let resolutionSignal: AbortSignal | undefined;
  const s = setup({
    execute: async () => conflictResult,
    useCloud: async (_snapshot, _etag, _revision, signal) => {
      resolutionSignal = signal;
      return resolution.promise;
    },
  });
  await s.controller.syncNow("manual");

  const running = s.controller.resolveConflict("cloud");
  assert.equal(resolutionSignal?.aborted, false);
  s.controller.dispose();
  assert.equal(resolutionSignal?.aborted, true);
  resolution.resolve(completed);
  await running;
});

test("network failure keeps dirty state without a busy retry loop", async () => {
  let fail = true;
  const s = setup({ auto: false, execute: async () => {
    if (fail) throw new Error("network");
    return completed;
  } });
  s.flags.auto = true;
  s.controller.notifyLocalChange();
  await s.clock.advance(LOCAL_DEBOUNCE_MS);
  await s.controller.whenIdle();
  assert.equal(s.calls(), 1);
  await s.clock.advance(60_000);
  assert.equal(s.calls(), 1);
  fail = false;
  s.controller.notifyOnline();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2);
  assert.equal(s.events.includes("fail"), true);
});

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

test("lifecycle wires hydrated resume changes and visible browser transitions exactly once", async () => {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget() as FakeEventTarget & { visibilityState: "visible" | "hidden" };
  documentTarget.visibilityState = "visible";
  const calls: string[] = [];
  let resumeListener: ((state: any, previous: any) => void) | null = null;
  const lifecycleInitial = {
    _hasHydrated: true,
    _isApplyingSyncSnapshot: false,
    resumes: { initial: {} },
    activeResumeId: "initial",
  };
  let unsubscribeCount = 0;
  const lifecycleController = {
    notifyOnline: () => { calls.push("online"); },
    notifyVisible: () => { calls.push("visible"); },
    notifyLocalChange: () => { calls.push("local"); },
    syncNow: async (reason: string) => { calls.push(`sync:${reason}`); },
    dispose: () => { calls.push("dispose"); },
  } as unknown as WebDavSyncController;

  const cleanup = attachWebDavLifecycle(lifecycleController, {
    windowTarget,
    documentTarget,
    getResumeState: () => lifecycleInitial,
    subscribeResume: (listener) => {
      assert.equal(resumeListener, null, "resume store subscribed once");
      resumeListener = listener;
      return () => { unsubscribeCount += 1; resumeListener = null; };
    },
    isAutoSyncEnabled: () => true,
  });

  assert.equal(windowTarget.listenerCount("online"), 1);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 1);
  assert.deepEqual(calls, ["sync:automatic"]);

  windowTarget.dispatch("online");
  documentTarget.visibilityState = "hidden";
  documentTarget.dispatch("visibilitychange");
  documentTarget.visibilityState = "visible";
  documentTarget.dispatch("visibilitychange");
  const unhydrated = { ...lifecycleInitial, _hasHydrated: false, resumes: {} };
  const applying = {
    ...lifecycleInitial,
    _isApplyingSyncSnapshot: true,
    resumes: { remote: {} },
    activeResumeId: "remote",
  };
  const local = {
    ...applying,
    _isApplyingSyncSnapshot: false,
    resumes: { remote: {}, local: {} },
  };
  resumeListener?.(unhydrated, lifecycleInitial);
  resumeListener?.(applying, unhydrated);
  resumeListener?.(local, applying);

  assert.deepEqual(calls, ["sync:automatic", "online", "visible", "local"]);

  cleanup();
  assert.equal(windowTarget.listenerCount("online"), 0);
  assert.equal(documentTarget.listenerCount("visibilitychange"), 0);
  assert.equal(unsubscribeCount, 1);
  assert.equal(calls.at(-1), "dispose");
});

test("lifecycle does not subscribe or run startup sync before resume hydration", () => {
  const windowTarget = new FakeEventTarget();
  const documentTarget = new FakeEventTarget() as FakeEventTarget & { visibilityState: "visible" | "hidden" };
  documentTarget.visibilityState = "visible";
  let subscriptions = 0;
  const calls: string[] = [];
  const lifecycleController = {
    notifyOnline: () => { calls.push("online"); },
    notifyVisible: () => { calls.push("visible"); },
    notifyLocalChange: () => { calls.push("local"); },
    syncNow: async () => { calls.push("sync"); },
    dispose: () => { calls.push("dispose"); },
  } as unknown as WebDavSyncController;

  const cleanup = attachWebDavLifecycle(lifecycleController, {
    windowTarget,
    documentTarget,
    getResumeState: () => ({
      _hasHydrated: false,
      _isApplyingSyncSnapshot: false,
      resumes: {},
      activeResumeId: null,
    }),
    subscribeResume: () => { subscriptions += 1; return () => {}; },
    isAutoSyncEnabled: () => true,
  });

  assert.equal(subscriptions, 0);
  assert.deepEqual(calls, []);
  cleanup();
  assert.deepEqual(calls, ["dispose"]);
});

const makeIntegratedResume = (id: string, title: string) => ({
  ...structuredClone(initialResumeState),
  id,
  title,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  templateId: "classic",
});

const configuredSettings = {
  baseUrl: "https://dav.example.test",
  username: "dongxing.123",
  password: "secret",
  remoteDirectory: "/magic-resume/",
  autoSyncEnabled: false,
};

test("configured controller downloads immutable objects through real stores without scheduling remote apply back", async () => {
  const local = makeIntegratedResume("local", "Local");
  const remote = makeIntegratedResume("remote", "Remote");
  const localHash = await calculateResumeHash(local);
  const remoteHash = await calculateResumeHash(remote);
  const manifest = await createManifest({
    schemaVersion: 2,
    revision: 2,
    parentRevision: 1,
    updatedAt: "2026-09-12T01:00:00.000Z",
    deviceId: "remote-device",
    activeResumeId: "remote",
    entries: {
      remote: {
        objectPath: `objects/remote/${remoteHash}.json`,
        mirrorPath: "resumes/Remote--remote.json",
        contentHash: remoteHash,
        updatedAt: remote.updatedAt,
        deleted: false,
      },
    },
  });
  const baseline: MultiFileBaseline = {
    manifestRevision: 1,
    manifestHash: "a".repeat(64),
    activeResumeId: "local",
    entries: {
      local: {
        objectPath: `objects/local/${localHash}.json`,
        mirrorPath: "resumes/Local--local.json",
        contentHash: localHash,
        deleted: false,
      },
    },
  };
  useResumeStore.setState({
    resumes: { local }, activeResumeId: "local", activeResume: local,
    history: {}, future: {}, _hasHydrated: true, _isApplyingSyncSnapshot: false,
    webDavBaseline: baseline,
  });
  useWebDavStore.setState({
    settings: configuredSettings, deviceId: "local-device", conflict: null,
    error: null, warning: null, status: "idle", isSyncing: false, abortController: null,
  });
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${new URL(url).pathname}`);
    if (method === "PROPFIND") {
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>', { status: 207 });
    }
    if (url.endsWith("/manifest.json")) {
      return new Response(serializeManifest(manifest), { status: 200, headers: { ETag: '"m2"' } });
    }
    if (url.endsWith(manifest.entries.remote.objectPath)) {
      return new Response(serializeResumeJson(remote), { status: 200, headers: { ETag: '"remote"' } });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const controller = createConfiguredController(configuredSettings, "local-device");
    assert.ok(controller);
    const cleanup = attachWebDavLifecycle(controller, {
      windowTarget: new FakeEventTarget(),
      documentTarget: Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const }),
      getResumeState: () => useResumeStore.getState(),
      subscribeResume: (listener) => useResumeStore.subscribe(listener),
      isAutoSyncEnabled: () => false,
    });
    await controller.syncNow("manual");
    await controller.whenIdle();

    assert.deepEqual(Object.keys(useResumeStore.getState().resumes), ["remote"]);
    assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
    assert.equal(useResumeStore.getState().webDavBaseline?.manifestHash, manifest.manifestHash);
    assert.equal(requests.some((request) => request.includes(manifest.entries.remote.objectPath)), true);
    assert.equal(useWebDavStore.getState().syncedResumeCount, 2);
    const appliedAt = useWebDavStore.getState().lastSyncedAt;
    assert.ok(appliedAt);

    await controller.syncNow("manual");
    assert.equal(useWebDavStore.getState().syncedResumeCount, 0);
    assert.ok(useWebDavStore.getState().lastSyncedAt);
    assert.ok(useWebDavStore.getState().lastSyncedAt! >= appliedAt);
    assert.doesNotMatch(
      JSON.stringify({
        syncedResumeCount: useWebDavStore.getState().syncedResumeCount,
        lastSyncedAt: useWebDavStore.getState().lastSyncedAt,
      }),
      /secret|dongxing|dav\.example|remote-device/,
    );
    cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("download adapter rejects stale canonical token before changing synchronized state", async () => {
  const local = makeIntegratedResume("local", "Local");
  const remote = makeIntegratedResume("remote", "Remote");
  const oldBaseline = { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" };
  const nextBaseline = { revision: "r2", contentHash: "b".repeat(64), syncedAt: "new" };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: oldBaseline,
  });

  assert.throws(
    () => commitDownloadedSnapshot({ resumes: [remote], activeResumeId: "remote" }, nextBaseline, "stale-token"),
    LocalCasMismatchError,
  );
  assert.deepEqual(Object.keys(useResumeStore.getState().resumes), ["local"]);
  assert.equal(useResumeStore.getState().webDavBaseline, oldBaseline);
});

test("download adapter leaves snapshot and baseline unchanged when commit preparation fails", async () => {
  const { canonicalizeSyncData } = await import("../src/lib/webdav/snapshot");
  const local = makeIntegratedResume("local", "Local");
  const remote = makeIntegratedResume("remote", "Remote");
  (remote.basic as any).name = () => "uncloneable";
  const oldBaseline = { revision: "r1", contentHash: "a".repeat(64), syncedAt: "old" };
  const nextBaseline = { revision: "r2", contentHash: "b".repeat(64), syncedAt: "new" };
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    webDavBaseline: oldBaseline,
  });
  let notifications = 0;
  const unsubscribe = useResumeStore.subscribe(() => { notifications += 1; });

  assert.throws(() => commitDownloadedSnapshot(
    { resumes: [remote], activeResumeId: "remote" },
    nextBaseline,
    canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  ));
  unsubscribe();

  assert.deepEqual(Object.keys(useResumeStore.getState().resumes), ["local"]);
  assert.equal(useResumeStore.getState().activeResumeId, "local");
  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
  assert.equal(useResumeStore.getState().webDavBaseline, oldBaseline);
  assert.equal(notifications, 0);
});

test("configured controller stores only safe error code and status", async () => {
  useResumeStore.setState({ _hasHydrated: true });
  useWebDavStore.setState({ settings: configuredSettings, error: null });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("password=secret"); }) as typeof fetch;
  try {
    const controller = createConfiguredController(configuredSettings, "local-device");
    assert.ok(controller);
    await controller.syncNow("manual");
    assert.deepEqual(useWebDavStore.getState().error, { code: "NETWORK", status: null });
    assert.deepEqual(Object.keys(useWebDavStore.getState().error ?? {}).sort(), ["code", "status"]);
    controller.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy aggregate payload failures surface only a safe manifest code", async () => {
  useResumeStore.setState({ _hasHydrated: true, webDavBaseline: null });
  useWebDavStore.setState({ settings: configuredSettings, error: null });
  const originalFetch = globalThis.fetch;
  const baseSnapshot = {
    schemaVersion: 1,
    revision: "remote-r1",
    parentRevision: null,
    updatedAt: "2026-09-12T12:00:00.000Z",
    deviceId: "remote-device",
    contentHash: "a".repeat(64),
    data: { resumes: [], activeResumeId: null },
  };
  const cases = [
    ["MANIFEST_SHAPE", { ...baseSnapshot, schemaVersion: 2 }],
    ["MANIFEST_VERSION", {
      ...baseSnapshot,
      data: { resumes: [{ id: "raw-server-body-password=secret" }], activeResumeId: null },
    }],
    ["MANIFEST_VERSION", baseSnapshot],
  ] as const;

  try {
    for (const [code, body] of cases) {
      useWebDavStore.setState({ error: null, status: "idle" });
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
      const controller = createConfiguredController(configuredSettings, "local-device");
      assert.ok(controller);

      await controller.syncNow("manual");

      assert.deepEqual(useWebDavStore.getState().error, { code, status: null });
      assert.deepEqual(Object.keys(useWebDavStore.getState().error ?? {}).sort(), ["code", "status"]);
      assert.doesNotMatch(JSON.stringify(useWebDavStore.getState().error), /password|secret|raw-server-body/);
      controller.dispose();
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("controller construction requires hydration and every credential field", () => {
  useResumeStore.setState({ _hasHydrated: false });
  assert.equal(createConfiguredController(configuredSettings, "device"), null);
  useResumeStore.setState({ _hasHydrated: true });
  for (const key of ["baseUrl", "username", "password", "remoteDirectory"] as const) {
    assert.equal(createConfiguredController({ ...configuredSettings, [key]: "" }, "device"), null, key);
  }
  assert.equal(getWebDavSyncController(), null);
});

test("invalid configured URL is mapped to safe store state instead of escaping", () => {
  useResumeStore.setState({ _hasHydrated: true });
  useWebDavStore.setState({ error: null, status: "idle" });

  assert.doesNotThrow(() => {
    assert.equal(createConfiguredController({ ...configuredSettings, baseUrl: "not a url" }, "device"), null);
  });
  assert.deepEqual(useWebDavStore.getState().error, { code: "UNKNOWN", status: null });
  assert.deepEqual(Object.keys(useWebDavStore.getState().error ?? {}).sort(), ["code", "status"]);
});

test("lifecycle ignores guard-only reset after remote commit but forwards a real local snapshot change", () => {
  const windowTarget = new FakeEventTarget();
  const documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const });
  let resumeListener: ((state: any, previous: any) => void) | null = null;
  let localChanges = 0;
  const lifecycleController = {
    notifyOnline: () => {},
    notifyVisible: () => {},
    notifyLocalChange: () => { localChanges += 1; },
    syncNow: async () => {},
    dispose: () => {},
  } as unknown as WebDavSyncController;
  const original = {
    _hasHydrated: true,
    _isApplyingSyncSnapshot: false,
    resumes: { local: {} },
    activeResumeId: "local",
  };
  const remoteApplying = {
    ...original,
    _isApplyingSyncSnapshot: true,
    resumes: { remote: {} },
    activeResumeId: "remote",
  };
  const remoteSettled = { ...remoteApplying, _isApplyingSyncSnapshot: false };
  const localEdited = { ...remoteSettled, resumes: { remote: {}, local: {} } };

  const cleanup = attachWebDavLifecycle(lifecycleController, {
    windowTarget,
    documentTarget,
    getResumeState: () => original,
    subscribeResume: (listener) => { resumeListener = listener as typeof resumeListener; return () => {}; },
    isAutoSyncEnabled: () => false,
  });
  resumeListener?.(remoteApplying, original);
  resumeListener?.(remoteSettled, remoteApplying);
  resumeListener?.(localEdited, remoteSettled);

  assert.equal(localChanges, 1);
  cleanup();
});

test("configured controller does not migrate a legacy aggregate baseline", () => {
  const legacyBaseline = {
    revision: "legacy-r1",
    contentHash: "d".repeat(64),
    syncedAt: "2026-09-12T12:00:00.000Z",
  };
  useResumeStore.setState({ _hasHydrated: true, webDavBaseline: null });
  useWebDavStore.setState({ legacyBaseline });

  const controller = createConfiguredController(configuredSettings, "device");

  assert.ok(controller);
  assert.equal(useResumeStore.getState().webDavBaseline, null);
  assert.equal(useWebDavStore.getState().legacyBaseline, legacyBaseline);
  controller.dispose();
});

test("reconfiguration after clearCredentials performs first sync without the old baseline", async () => {
  const local = makeIntegratedResume("local", "Local");
  const remote = makeIntegratedResume("remote", "Remote");
  const localData = { resumes: [local], activeResumeId: "local" };
  const cloud = await createCloudSnapshot(
    { resumes: [remote], activeResumeId: "remote" },
    {
      revision: "new-server-r1",
      parentRevision: null,
      updatedAt: "2026-09-12T01:00:00.000Z",
      deviceId: "new-server",
    },
  );
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    _hasHydrated: true,
    webDavBaseline: {
      revision: "old-server-r1",
      contentHash: await calculateContentHash(localData),
      syncedAt: "2026-09-12T00:00:00.000Z",
    },
  });
  useWebDavStore.setState({ settings: configuredSettings, conflict: null });
  useWebDavStore.getState().clearCredentials();
  useWebDavStore.getState().setSettings(configuredSettings);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(cloud), { status: 200 })) as typeof fetch;

  try {
    const controller = createConfiguredController(configuredSettings, "local-device");
    assert.ok(controller);
    await controller.syncNow("manual");

    assert.deepEqual(Object.keys(useResumeStore.getState().resumes), ["local"]);
    assert.equal(useResumeStore.getState().webDavBaseline, null);
    assert.equal(useWebDavStore.getState().conflict, null);
    assert.deepEqual(useWebDavStore.getState().error, { code: "MANIFEST_VERSION", status: null });
    controller.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lifecycle recognizes a later local edit after guarded commit notification throws", () => {
  const local = makeIntegratedResume("local", "Local");
  const remote = makeIntegratedResume("remote", "Remote");
  useResumeStore.setState({
    resumes: { local },
    activeResumeId: "local",
    activeResume: local,
    _hasHydrated: true,
    _isApplyingSyncSnapshot: false,
    webDavBaseline: null,
  });
  let localChanges = 0;
  const controller = {
    notifyOnline: () => {},
    notifyVisible: () => {},
    notifyLocalChange: () => { localChanges += 1; },
    syncNow: async () => {},
    dispose: () => {},
  } as unknown as WebDavSyncController;
  const cleanup = attachWebDavLifecycle(controller, {
    windowTarget: new FakeEventTarget(),
    documentTarget: Object.assign(new FakeEventTarget(), { visibilityState: "visible" as const }),
    getResumeState: () => useResumeStore.getState(),
    subscribeResume: (listener) => useResumeStore.subscribe(listener),
    isAutoSyncEnabled: () => false,
  });
  const unsubscribeThrowing = useResumeStore.subscribe(() => {
    throw new Error("subscriber failed");
  });
  const baseline: MultiFileBaseline = {
    manifestRevision: 2,
    manifestHash: "b".repeat(64),
    activeResumeId: "remote",
    entries: {
      remote: {
        contentHash: "c".repeat(64), deleted: false,
        objectPath: `objects/remote/${"c".repeat(64)}.json`,
        mirrorPath: "resumes/Remote--remote.json",
      },
    },
  };

  assert.throws(() => useResumeStore.getState().commitWebDavSync({
    data: { resumes: [remote], activeResumeId: "remote" },
    baseline,
    expectedLocalToken: canonicalizeSyncData({ resumes: [local], activeResumeId: "local" }),
  }), /subscriber failed/);
  unsubscribeThrowing();
  useResumeStore.setState({ resumes: { ...useResumeStore.getState().resumes } });

  assert.equal(useResumeStore.getState()._isApplyingSyncSnapshot, false);
  assert.deepEqual(useResumeStore.getState().webDavBaseline, baseline);
  assert.equal(localChanges, 1);
  cleanup();
});

test("remote deletion after keep-local CAS defers safely and remains retryable", async () => {
  const deferredResult = {
    status: "deferred",
    warning: null,
    reason: "REMOTE_MISSING_AFTER_CAS",
  } as const;
  const s = setup({
    execute: async () => s.calls() === 1 ? conflictResult : completed,
    keepLocal: async () => deferredResult,
  });
  await s.controller.syncNow("manual");

  await s.controller.resolveConflict("local");

  assert.equal(s.hasConflict(), false, "the stale conflict dialog must close");
  assert.equal(s.events.includes("defer"), true);
  assert.equal(s.events.includes("fail"), false);
  assert.equal(s.events.some((event) => event.startsWith("complete:")), false);
  assert.equal(s.calls(), 1, "resolution deferral must not busy-loop");

  s.controller.notifyOnline();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2, "deferred resolution remains dirty and retryable");
});

test("local stabilization deferral stays dirty without conflict, UNKNOWN error, or busy loop", async () => {
  let conflicts = 0;
  const deferredResult = {
    status: "deferred",
    warning: null,
    reason: "LOCAL_UNSTABLE",
  } as const;
  const s = setup({
    execute: async () => s.calls() === 1 ? deferredResult : completed,
    createConflict: () => {
      conflicts += 1;
      return conflict;
    },
  });

  await s.controller.syncNow("manual");
  await settle();

  assert.equal(s.calls(), 1, "bounded coordinator exhaustion must not busy-loop");
  assert.equal(conflicts, 0);
  assert.equal(s.hasConflict(), false);
  assert.equal(s.events.includes("fail"), false);
  assert.equal(s.events.includes("defer"), true);

  s.controller.notifyOnline();
  await s.controller.whenIdle();
  assert.equal(s.calls(), 2, "dirty deferral remains retryable");
});


test("resolving multiple resumes pauses then runs exactly one dirty follow-up after the final conflict", async () => {
  const productResume = makeIntegratedResume("full-id", "产品经理简历");
  const designResume = makeIntegratedResume("design-id", "设计师简历");
  const conflicts = [
    {
      resumeId: productResume.id,
      title: productResume.title,
      kind: "both-modified" as const,
      localUpdatedAt: "2026-09-12T08:00:00.000Z",
      remoteUpdatedAt: "2026-09-12T09:00:00.000Z",
      local: productResume,
      remoteEntry: {
        objectPath: `objects/full-id/${"a".repeat(64)}.json`,
        mirrorPath: "resumes/product.json",
        contentHash: "a".repeat(64),
        updatedAt: "2026-09-12T09:00:00.000Z",
        deleted: false,
      },
    },
    {
      resumeId: designResume.id,
      title: designResume.title,
      kind: "delete-vs-modify" as const,
      localUpdatedAt: designResume.updatedAt,
      remoteUpdatedAt: null,
      local: designResume,
      remoteEntry: null,
    },
  ];
  const manifest = {
    schemaVersion: 2 as const,
    revision: 7,
    parentRevision: 6,
    updatedAt: "2026-09-12T09:00:00.000Z",
    deviceId: "cloud-device",
    activeResumeId: productResume.id,
    entries: {},
    manifestHash: "b".repeat(64),
  };
  const inspection = {
    decision: "conflict" as const,
    localData: { resumes: [productResume, designResume], activeResumeId: productResume.id },
    localToken: "token",
    localHashes: {},
    manifest,
    persistedManifest: manifest,
    remoteEtag: '"manifest-7"',
    plan: {
      uploads: [], downloads: [], trashMoves: [], remoteDeletions: [],
      conflicts, nextActiveResumeId: productResume.id,
    },
    conflicts,
    warnings: [],
    discoveredRemoteFiles: false,
  };
  let visibleConflicts: typeof conflicts = [];
  const decisions: unknown[] = [];
  let executeCalls = 0;
  const firstResolution = deferred<SyncExecuteResult>();
  const secondResolution = deferred<SyncExecuteResult>();
  const controller = new WebDavSyncController({
    coordinator: {
      inspect: async () => inspection,
      execute: async (decisionOrSignal?: unknown) => {
        executeCalls += 1;
        if (decisionOrSignal instanceof AbortSignal || decisionOrSignal === undefined) {
          return executeCalls === 1 ? inspection : completed;
        }
        decisions.push(decisionOrSignal);
        return decisions.length === 1 ? firstResolution.promise : secondResolution.promise;
      },
    },
    client: { options: async () => {}, propfind: async () => true } as WebDavClientApi,
    remoteDirectory: "/sync/",
    isApplyingRemote: () => false,
    createConflict: () => conflict,
    state: {
      isConfigured: () => true,
      isHydrated: () => true,
      isAutoSyncEnabled: () => true,
      isOnline: () => true,
      isVisible: () => true,
      hasConflict: () => visibleConflicts.length > 0,
      begin: () => {},
      complete: () => {},
      defer: () => {},
      fail: () => {},
      setConflict: () => {},
      clearConflict: () => { visibleConflicts = []; },
      setConflicts: (next: typeof conflicts) => { visibleConflicts = next; },
    } as SyncControllerState,
  } as any);

  await controller.syncNow("manual");
  assert.deepEqual(visibleConflicts.map((item) => item.resumeId), ["full-id", "design-id"]);

  const resolving = controller.resolveConflict("full-id", "keep-local");
  controller.notifyLocalChange();
  controller.notifyLocalChange();
  firstResolution.resolve({ ...inspection, conflicts: [conflicts[1]], plan: { ...inspection.plan, conflicts: [conflicts[1]] } });
  await resolving;
  await controller.whenIdle();

  assert.deepEqual(decisions, [{
    resumeId: "full-id",
    resolution: "keep-local",
    seenRemoteEtag: '"manifest-7"',
    seenManifestRevision: 7,
  }]);
  assert.deepEqual(visibleConflicts.map((item) => item.resumeId), ["design-id"]);
  assert.equal(executeCalls, 2, "a remaining conflict must keep automatic follow-up paused");

  const resolvingLastConflict = controller.resolveConflict("design-id", "use-cloud");
  secondResolution.resolve(completed);
  await resolvingLastConflict;
  await controller.whenIdle();

  assert.deepEqual(decisions, [
    {
      resumeId: "full-id",
      resolution: "keep-local",
      seenRemoteEtag: '"manifest-7"',
      seenManifestRevision: 7,
    },
    {
      resumeId: "design-id",
      resolution: "use-cloud",
      seenRemoteEtag: '"manifest-7"',
      seenManifestRevision: 7,
    },
  ]);
  assert.equal(executeCalls, 4, "clearing the final conflict must run one dirty follow-up");
});

test("coalesces opposite queued decisions for the same resume", async () => {
  const resume = makeIntegratedResume("full-id", "产品经理简历");
  const resumeConflict = {
    resumeId: resume.id,
    title: resume.title,
    kind: "both-modified" as const,
    localUpdatedAt: "2026-09-12T08:00:00.000Z",
    remoteUpdatedAt: "2026-09-12T09:00:00.000Z",
    local: resume,
    remoteEntry: {
      objectPath: `objects/full-id/${"a".repeat(64)}.json`,
      mirrorPath: "resumes/product.json",
      contentHash: "a".repeat(64),
      updatedAt: "2026-09-12T09:00:00.000Z",
      deleted: false,
    },
  };
  const inspection = {
    decision: "conflict" as const,
    localData: { resumes: [resume], activeResumeId: resume.id },
    localToken: "token",
    localHashes: {},
    manifest: {
      schemaVersion: 2 as const,
      revision: 7,
      parentRevision: 6,
      updatedAt: "2026-09-12T09:00:00.000Z",
      deviceId: "cloud-device",
      activeResumeId: resume.id,
      entries: {},
      manifestHash: "b".repeat(64),
    },
    persistedManifest: null,
    remoteEtag: '"manifest-7"',
    plan: {
      uploads: [], downloads: [], trashMoves: [], remoteDeletions: [],
      conflicts: [resumeConflict], nextActiveResumeId: resume.id,
    },
    conflicts: [resumeConflict],
    warnings: [],
    discoveredRemoteFiles: false,
  };
  let visibleConflicts = [resumeConflict];
  const decisions: unknown[] = [];
  const firstResolution = deferred<SyncExecuteResult>();
  const controller = new WebDavSyncController({
    coordinator: {
      inspect: async () => inspection,
      execute: async (decisionOrSignal?: unknown) => {
        if (decisionOrSignal instanceof AbortSignal || decisionOrSignal === undefined) return inspection;
        decisions.push(decisionOrSignal);
        return firstResolution.promise;
      },
    },
    client: { options: async () => {}, propfind: async () => true } as WebDavClientApi,
    remoteDirectory: "/sync/",
    isApplyingRemote: () => false,
    createConflict: () => conflict,
    state: {
      isConfigured: () => true,
      isHydrated: () => true,
      isAutoSyncEnabled: () => true,
      isOnline: () => true,
      isVisible: () => true,
      hasConflict: () => visibleConflicts.length > 0,
      begin: () => {},
      complete: () => {},
      defer: () => {},
      fail: () => {},
      setConflict: () => {},
      clearConflict: () => { visibleConflicts = []; },
      setConflicts: (next: typeof visibleConflicts) => { visibleConflicts = next; },
    } as SyncControllerState,
  } as any);

  await controller.syncNow("manual");
  const keepingLocal = controller.resolveConflict("full-id", "keep-local");
  const usingCloud = controller.resolveConflict("full-id", "use-cloud");
  firstResolution.resolve(completed);
  await Promise.all([keepingLocal, usingCloud]);
  await controller.whenIdle();

  assert.deepEqual(decisions, [{
    resumeId: "full-id",
    resolution: "keep-local",
    seenRemoteEtag: '"manifest-7"',
    seenManifestRevision: 7,
  }], "a queued opposite choice must not execute after the first choice resolves the conflict");
});

test("successful applied and no-op syncs publish only count and completion time state", async () => {
  const completions: Array<{ warning: unknown; syncedCount: unknown }> = [];
  let call = 0;
  const controller = new WebDavSyncController({
    coordinator: {
      inspect: async () => conflictResult as any,
      execute: async () => {
        call += 1;
        return call === 1
          ? { status: "downloaded", warning: null, syncedCount: 3 } as const
          : { status: "unchanged", warning: null, syncedCount: 0 } as const;
      },
    },
    client: { options: async () => {}, propfind: async () => true } as WebDavClientApi,
    remoteDirectory: "/sync/?token=private",
    isApplyingRemote: () => false,
    createConflict: () => conflict,
    state: {
      isConfigured: () => true,
      isHydrated: () => true,
      isAutoSyncEnabled: () => true,
      isOnline: () => true,
      isVisible: () => true,
      hasConflict: () => false,
      begin: () => {},
      complete: (warning: unknown, syncedCount?: number) => { completions.push({ warning, syncedCount }); },
      defer: () => {},
      fail: () => {},
      setConflict: () => {},
      clearConflict: () => {},
      setConflicts: () => {},
    } as SyncControllerState,
  } as any);

  await controller.syncNow("manual");
  await controller.syncNow("manual");

  assert.deepEqual(completions, [
    { warning: null, syncedCount: 3 },
    { warning: null, syncedCount: 0 },
  ]);
  assert.doesNotMatch(JSON.stringify(completions), /private|token|resume/i);
});
