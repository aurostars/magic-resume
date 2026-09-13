import type { WebDavClientApi } from "./client";
import {
  LocalCasMismatchError,
  type SyncExecuteResult,
  type SyncInspection,
  type WebDavSyncCoordinator,
} from "./coordinator";
import type { CloudSnapshotV1 } from "./types";
import type { WebDavConflict } from "../../store/useWebDavStore";

export const LOCAL_DEBOUNCE_MS = 5_000;
export const FOREGROUND_MIN_INTERVAL_MS = 60_000;

export interface SyncControllerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface SyncControllerState {
  isConfigured(): boolean;
  isHydrated(): boolean;
  isAutoSyncEnabled(): boolean;
  isOnline(): boolean;
  isVisible(): boolean;
  hasConflict(): boolean;
  begin(controller: AbortController): void;
  complete(warning: "NON_ATOMIC_UPLOAD" | null): void;
  defer(): void;
  fail(error: unknown): void;
  setConflict(conflict: WebDavConflict): void;
  clearConflict(): void;
}

type ConflictInspection = Extract<SyncInspection, { decision: "conflict" }>;
type CoordinatorApi = Pick<
  WebDavSyncCoordinator,
  "inspect" | "execute" | "keepLocal" | "useCloud"
>;
type FlightKey = "sync" | "test" | "resolve:local" | "resolve:cloud";
type FlightOperation = (signal: AbortSignal) => Promise<boolean>;

interface QueuedFlight {
  key: FlightKey;
  operation: FlightOperation;
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

export interface WebDavSyncControllerDependencies {
  coordinator: CoordinatorApi;
  client: WebDavClientApi;
  state: SyncControllerState;
  remoteDirectory: string;
  createConflict(conflict: ConflictInspection): WebDavConflict;
  isApplyingRemote(): boolean;
  clock?: SyncControllerClock;
}

const systemClock: SyncControllerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const isConflict = (result: SyncExecuteResult): result is ConflictInspection =>
  "decision" in result && result.decision === "conflict";

const isDeferred = (
  result: SyncExecuteResult,
): result is Extract<SyncExecuteResult, { status: "deferred" }> =>
  "status" in result && result.status === "deferred";

export class WebDavSyncController {
  private readonly clock: SyncControllerClock;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private activeKey: FlightKey | null = null;
  private activeController: AbortController | null = null;
  private readonly queue: QueuedFlight[] = [];
  private dirty = false;
  private disposed = false;
  private lastForegroundCheck = Number.NEGATIVE_INFINITY;
  private surfacedConflict: WebDavConflict | null = null;

  constructor(private readonly dependencies: WebDavSyncControllerDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  testConnection(): Promise<void> {
    return this.enqueue("test", async (signal) => {
      try {
        await this.dependencies.client.options(this.dependencies.remoteDirectory, signal);
        await this.dependencies.client.propfind(this.dependencies.remoteDirectory, signal);
        this.dependencies.state.complete(null);
        return true;
      } catch (error) {
        this.dependencies.state.fail(error);
        throw error;
      }
    });
  }

  syncNow(reason: "manual" | "automatic" = "manual"): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (reason === "automatic" && !this.canAutoSync()) return Promise.resolve();
    if (this.active) {
      if (this.activeKey === "sync") {
        this.dirty = true;
        return this.active;
      }
      return this.enqueue("sync", (signal) => this.performSync(signal));
    }

    this.clearDebounce();
    this.dirty = false;
    return this.startFlight("sync", (signal) => this.performSync(signal));
  }

  private async performSync(signal: AbortSignal): Promise<boolean> {
    try {
      const result = await this.dependencies.coordinator.execute(signal);
      if (isDeferred(result)) {
        this.dirty = true;
        this.dependencies.state.defer();
        return false;
      }
      this.handleResult(result);
      return true;
    } catch (error) {
      if (error instanceof LocalCasMismatchError) {
        await this.refreshConflict(signal);
        return true;
      }
      this.dirty = true;
      this.dependencies.state.fail(error);
      return false;
    }
  }

  notifyLocalChange(): void {
    if (this.disposed || this.dependencies.isApplyingRemote()) return;
    this.dirty = true;
    if (this.active || !this.canAutoSync()) return;
    this.clearDebounce();
    this.debounceTimer = this.clock.setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow("automatic");
    }, LOCAL_DEBOUNCE_MS);
  }

  notifyOnline(): void {
    if (this.disposed || !this.dirty || !this.canAutoSync()) return;
    this.clearDebounce();
    void this.syncNow("automatic");
  }

  notifyVisible(): void {
    if (
      this.disposed ||
      !this.dependencies.state.isVisible() ||
      !this.canAutoSync()
    ) return;
    const now = this.clock.now();
    if (now - this.lastForegroundCheck < FOREGROUND_MIN_INTERVAL_MS) return;
    this.lastForegroundCheck = now;
    void this.syncNow("automatic");
  }

  dismissConflict(): void {
    // Dismissal only closes presentation. The conflict remains as the auto-sync lock.
  }

  resolveConflict(choice: "local" | "cloud"): Promise<void> {
    if (this.disposed || !this.surfacedConflict) return Promise.resolve();
    const key: FlightKey = `resolve:${choice}`;
    return this.enqueue(key, async (signal) => {
      const current = this.surfacedConflict;
      if (!current) return true;
      this.dirty = false;
      try {
        const result = choice === "local"
          ? await this.dependencies.coordinator.keepLocal(
              current.snapshot,
              current.remoteEtag,
              current.manifestRevision,
              signal,
            )
          : await this.dependencies.coordinator.useCloud(
              current.snapshot,
              current.remoteEtag,
              current.manifestRevision,
              signal,
            );
        if (isConflict(result)) {
          this.surfaceConflict(result);
          return true;
        }
        if (isDeferred(result)) {
          this.dirty = true;
          this.clearConflict();
          this.dependencies.state.defer();
          return false;
        }
        this.clearConflict();
        this.dependencies.state.complete(result.warning);
        return true;
      } catch (error) {
        if (error instanceof LocalCasMismatchError) {
          await this.refreshConflict(signal);
          return true;
        }
        this.dependencies.state.fail(error);
        throw error;
      }
    });
  }

  async whenIdle(): Promise<void> {
    while (this.active || this.queue.length > 0) {
      try {
        await this.active;
      } catch {
        // Public operations report their own errors; idleness still waits for the queue.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearDebounce();
    for (const queued of this.queue.splice(0)) queued.resolve();
    this.activeController?.abort();
  }

  private enqueue(key: FlightKey, operation: FlightOperation): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.active) return this.startFlight(key, operation);
    if (this.activeKey === key) return this.active;
    const existing = this.queue.find((queued) => queued.key === key);
    if (existing) return existing.promise;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.queue.push({ key, operation, promise, resolve, reject });
    return promise;
  }

  private startFlight(key: FlightKey, operation: FlightOperation): Promise<void> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const flight = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const controller = new AbortController();

    // Publish the complete lock before begin() or any external dependency can re-enter.
    this.active = flight;
    this.activeKey = key;
    this.activeController = controller;
    if (key === "sync") this.dirty = false;

    void (async () => {
      let allowFollowUp = false;
      try {
        this.dependencies.state.begin(controller);
        allowFollowUp = await operation(controller.signal);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        if (this.activeController === controller) this.activeController = null;
        this.active = null;
        this.activeKey = null;
        if (
          allowFollowUp &&
          this.dirty &&
          !this.queue.some((queued) => queued.key === "sync") &&
          this.canRunFollowUp()
        ) {
          void this.syncNow("manual");
        } else {
          this.drainQueue();
        }
      }
    })();

    return flight;
  }

  private drainQueue(): void {
    if (this.disposed || this.active) return;
    const queued = this.queue.shift();
    if (!queued) return;
    this.startFlight(queued.key, queued.operation).then(queued.resolve, queued.reject);
  }

  private canRunFollowUp(): boolean {
    const state = this.dependencies.state;
    return !this.disposed &&
      state.isHydrated() &&
      state.isConfigured() &&
      state.isOnline() &&
      !state.hasConflict();
  }

  private canAutoSync(): boolean {
    return this.canRunFollowUp() && this.dependencies.state.isAutoSyncEnabled();
  }

  private handleResult(result: SyncExecuteResult): void {
    if (isConflict(result)) {
      this.surfaceConflict(result);
      return;
    }
    this.clearConflict();
    this.dependencies.state.complete(result.warning);
  }

  private async refreshConflict(signal: AbortSignal): Promise<void> {
    const inspection = await this.dependencies.coordinator.inspect(signal);
    if (inspection.decision === "conflict") this.surfaceConflict(inspection);
  }

  private clearConflict(): void {
    this.surfacedConflict = null;
    this.dependencies.state.clearConflict();
  }

  private surfaceConflict(result: ConflictInspection): void {
    const conflict = this.dependencies.createConflict(result);
    this.surfacedConflict = conflict;
    this.dependencies.state.setConflict(conflict);
  }

  private clearDebounce(): void {
    if (this.debounceTimer === null) return;
    this.clock.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }
}
