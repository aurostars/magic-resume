import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type PersistStorage,
} from "zustand/middleware";
import type { WebDavClientConfig } from "../lib/webdav/client";
import type { WebDavErrorCode } from "../lib/webdav/errors";
import type {
  CloudSnapshotV1,
  SnapshotValidationCode,
} from "../lib/webdav/types";
import { useResumeStore } from "./useResumeStore";
export type { WebDavBaseline } from "../lib/webdav/types";

export interface WebDavSettings
  extends Pick<WebDavClientConfig, "baseUrl" | "username" | "password"> {
  remoteDirectory: string;
  autoSyncEnabled: boolean;
}

export type WebDavStatus =
  | "idle"
  | "testing"
  | "syncing"
  | "success"
  | "warning"
  | "error"
  | "conflict";

export interface ConflictSide {
  updatedAt: string;
  deviceId: string;
  resumeCount: number;
}

export interface WebDavConflict {
  local: ConflictSide;
  cloud: ConflictSide;
  snapshot: CloudSnapshotV1;
  remoteEtag: string | null;
}

export interface WebDavSafeError {
  code: WebDavErrorCode | SnapshotValidationCode;
  status: number | null;
}

export interface PersistedWebDavState {
  settings: WebDavSettings;
  deviceId: string;
}

export interface WebDavState extends PersistedWebDavState {
  isSyncing: boolean;
  abortController: AbortController | null;
  conflict: WebDavConflict | null;
  status: WebDavStatus;
  error: WebDavSafeError | null;
  warning: WebDavSafeError | null;
  setSettings: (settings: Partial<WebDavSettings>) => void;
  setAutoSyncEnabled: (enabled: boolean) => void;
  beginRequest: (controller: AbortController, status?: "testing" | "syncing") => void;
  finishRequest: (status?: WebDavStatus) => void;
  setConflict: (conflict: WebDavConflict | null) => void;
  setWarning: (warning: WebDavSafeError | null) => void;
  setError: (error: WebDavSafeError | null) => void;
  clearTransientState: () => void;
  clearCredentials: () => void;
}

const defaultSettings = (): WebDavSettings => ({
  baseUrl: "",
  username: "",
  password: "",
  remoteDirectory: "/magic-resume/",
  autoSyncEnabled: false,
});

export const createDefaultWebDavState = (
  deviceId: string,
): Omit<WebDavState, keyof WebDavActions> => ({
  settings: defaultSettings(),
  deviceId,
  isSyncing: false,
  abortController: null,
  conflict: null,
  status: "idle",
  error: null,
  warning: null,
});

type WebDavActions = Pick<
  WebDavState,
  | "setSettings"
  | "setAutoSyncEnabled"
  | "beginRequest"
  | "finishRequest"
  | "setConflict"
  | "setWarning"
  | "setError"
  | "clearTransientState"
  | "clearCredentials"
>;

export const selectPersistedWebDavState = <
  T extends Pick<WebDavState, "settings" | "deviceId">,
>(state: T): PersistedWebDavState => ({
  settings: state.settings,
  deviceId: state.deviceId,
});

const generateDeviceId = (): string => crypto.randomUUID();

const sanitizeSafeError = (
  value: WebDavSafeError | null,
): WebDavSafeError | null =>
  value === null ? null : { code: value.code, status: value.status };

export const createWebDavStore = (
  storage?: PersistStorage<PersistedWebDavState>,
) => {
  const deviceId = generateDeviceId();
  return create<WebDavState>()(
    persist<WebDavState, [], [], PersistedWebDavState>(
      (set, get) => ({
        ...createDefaultWebDavState(deviceId),
        setSettings: (settings) =>
          set((state) => ({ settings: { ...state.settings, ...settings } })),
        setAutoSyncEnabled: (autoSyncEnabled) =>
          set((state) => ({ settings: { ...state.settings, autoSyncEnabled } })),
        beginRequest: (abortController, status = "syncing") =>
          set({ abortController, isSyncing: true, status, error: null, warning: null }),
        finishRequest: (status = "idle") =>
          set({ abortController: null, isSyncing: false, status }),
        setConflict: (conflict) => set({ conflict, status: conflict ? "conflict" : "idle" }),
        setWarning: (warning) =>
          set({
            warning: sanitizeSafeError(warning),
            status: warning ? "warning" : "idle",
          }),
        setError: (error) =>
          set({
            error: sanitizeSafeError(error),
            status: error ? "error" : "idle",
          }),
        clearTransientState: () =>
          set({
            abortController: null,
            isSyncing: false,
            conflict: null,
            status: "idle",
            error: null,
            warning: null,
          }),
        clearCredentials: () => {
          get().abortController?.abort();
          useResumeStore.getState().clearWebDavBaseline();
          set({
            settings: defaultSettings(),
            abortController: null,
            isSyncing: false,
            conflict: null,
            status: "idle",
            error: null,
            warning: null,
          });
        },
      }),
      {
        name: "webdav-sync-storage",
        storage:
          storage ??
          createJSONStorage<PersistedWebDavState>(() => localStorage),
        partialize: selectPersistedWebDavState,
      },
    ),
  );
};

export const useWebDavStore = createWebDavStore();
