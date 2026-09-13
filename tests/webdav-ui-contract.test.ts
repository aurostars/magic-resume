import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import en from "../src/i18n/locales/en.json";
import zh from "../src/i18n/locales/zh.json";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://magic-resume.test/",
  pretendToBeVisual: true,
});
const browserGlobals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLSelectElement: dom.window.HTMLSelectElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  MutationObserver: dom.window.MutationObserver,
  CustomEvent: dom.window.CustomEvent,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
};
for (const [key, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: dom.window.localStorage,
});
globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0) as unknown as number;
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

const testingLibrary = await import("@testing-library/react");
const { act, cleanup, fireEvent, render, screen, waitFor, within } = testingLibrary;
const userEvent = (await import("@testing-library/user-event")).default;
const [
  { NextIntlClientProvider },
  { WebDavSection },
  { WebDavConflictDialog },
  { useWebDavStore },
  { useResumeStore },
  { Providers },
] = await Promise.all([
  import("../src/i18n/compat/client"),
  import("../src/components/settings/WebDavSection"),
  import("../src/components/settings/WebDavConflictDialog"),
  import("../src/store/useWebDavStore"),
  import("../src/store/useResumeStore"),
  import("../src/app/providers"),
]);

const requiredKeys = [
  "title", "description", "serverUrl", "username", "password", "remoteDirectory",
  "autoSync", "testConnection", "syncNow", "clearCredentials", "clearConfirmTitle",
  "clearConfirmBody", "cancel", "confirm", "localStorageWarning", "dedicatedAccountHint",
  "lastSyncedAt", "neverSynced", "syncing", "success", "nonAtomicWarning", "authError",
  "forbiddenError", "networkError", "timeoutError", "directoryError", "quotaError",
  "corruptSnapshotError", "newerSnapshotError", "unknownError", "conflictTitle", "conflictBody",
  "localVersion", "cloudVersion", "resumeCount", "device", "updatedAt", "useLocal",
  "useCloud", "dismiss",
].sort();

const renderLocalized = (child: React.ReactElement, messages: typeof en = en) =>
  render(React.createElement(
    NextIntlClientProvider,
    { locale: messages === zh ? "zh" : "en", messages },
    child,
  ));

const resetStores = () => {
  useWebDavStore.getState().clearCredentials();
  useResumeStore.setState({ webDavBaseline: null });
};

afterEach(() => {
  cleanup();
  resetStores();
  document.body.replaceChildren();
});
after(() => dom.window.close());

test("English and Chinese expose the complete equivalent WebDAV locale contract", () => {
  const english = en.dashboard.settings.webdav;
  const chinese = zh.dashboard.settings.webdav;
  assert.deepEqual(Object.keys(english).sort(), requiredKeys);
  assert.deepEqual(Object.keys(chinese).sort(), requiredKeys);
  for (const key of requiredKeys) {
    assert.ok(english[key as keyof typeof english].trim());
    assert.ok(chinese[key as keyof typeof chinese].trim());
  }
});

test("settings exposes labeled DOM controls and protects the password", () => {
  resetStores();
  renderLocalized(React.createElement(WebDavSection));
  assert.equal(screen.getByLabelText("Server URL").tagName, "INPUT");
  assert.equal(screen.getByLabelText("Username").tagName, "INPUT");
  assert.equal(screen.getByLabelText("Password").getAttribute("type"), "password");
  assert.equal(screen.getByLabelText("Remote directory").tagName, "INPUT");
  assert.equal(screen.getByRole("switch", { name: "Automatically sync changes" }).getAttribute("aria-checked"), "false");
});

test("Test and Sync persist normalized drafts before calling the controller and prevent duplicate actions", async () => {
  resetStores();
  const user = userEvent.setup({ document });
  let finishTest!: () => void;
  const pendingTest = new Promise<void>((resolve) => { finishTest = resolve; });
  const calls: Array<{ action: string; settings: unknown }> = [];
  const controller = {
    testConnection: () => {
      calls.push({ action: "test", settings: useWebDavStore.getState().settings });
      return pendingTest;
    },
    syncNow: async () => {
      calls.push({ action: "sync", settings: useWebDavStore.getState().settings });
    },
    dismissConflict: () => {},
    resolveConflict: async () => {},
  };
  renderLocalized(React.createElement(WebDavSection, { controllerProvider: () => controller }));

  await user.type(screen.getByLabelText("Server URL"), "  https://dav.example.test/root/  ");
  await user.type(screen.getByLabelText("Username"), "  alice  ");
  await user.type(screen.getByLabelText("Password"), " secret ");
  await user.clear(screen.getByLabelText("Remote directory"));
  await user.type(screen.getByLabelText("Remote directory"), " resumes ");
  assert.equal(useWebDavStore.getState().settings.baseUrl, "");

  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const normalized = {
    baseUrl: "https://dav.example.test/root",
    username: "alice",
    password: " secret ",
    remoteDirectory: "/resumes/",
    autoSyncEnabled: false,
  };
  assert.deepEqual(calls[0], { action: "test", settings: normalized });
  assert.equal(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled"), true);
  assert.equal(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"), true);

  finishTest();
  await waitFor(() => assert.equal(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled"), false));
  await user.clear(screen.getByLabelText("Remote directory"));
  await user.type(screen.getByLabelText("Remote directory"), "next");
  await user.click(screen.getByRole("button", { name: "Sync now" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.deepEqual(calls[1], {
    action: "sync",
    settings: { ...normalized, remoteDirectory: "/next/" },
  });
});

test("clear confirmation is a trapped modal, closes with Escape, restores focus, and guards deletion", async () => {
  resetStores();
  useWebDavStore.getState().setSettings({
    baseUrl: "https://dav.example.test", username: "alice", password: "secret",
  });
  const user = userEvent.setup({ document });
  renderLocalized(React.createElement(WebDavSection));
  const trigger = screen.getByRole("button", { name: "Clear credentials" });
  trigger.focus();
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Clear WebDAV credentials?" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  const confirm = within(dialog).getByRole("button", { name: "Clear WebDAV credentials" });
  await waitFor(() => assert.ok(document.activeElement === cancel));
  assert.ok(trigger.closest("[aria-hidden='true']"), "background is hidden while modal is open");
  confirm.focus();
  fireEvent.keyDown(confirm, { key: "Tab" });
  assert.ok(document.activeElement === cancel);
  assert.equal(useWebDavStore.getState().settings.password, "secret");

  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  await waitFor(() => assert.ok(document.activeElement === trigger));
  assert.equal(useWebDavStore.getState().settings.password, "secret");

  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "Clear WebDAV credentials" }));
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.equal(useWebDavStore.getState().settings.password, "");
});

const conflict = {
  local: { updatedAt: "2026-09-12T08:00:00.000Z", deviceId: "local-device", resumeCount: 2 },
  cloud: { updatedAt: "2026-09-12T09:00:00.000Z", deviceId: "cloud-device", resumeCount: 3 },
  snapshot: {
    schemaVersion: 1 as const, revision: "r1", parentRevision: null,
    updatedAt: "2026-09-12T09:00:00.000Z", deviceId: "cloud-device",
    contentHash: "a".repeat(64), data: { resumes: [], activeResumeId: null },
  },
  remoteEtag: '"etag-r1"',
};

test("conflict dialog traps focus, closes on Escape without choosing a side, and restores focus", async () => {
  const user = userEvent.setup({ document });
  const opener = document.createElement("button");
  opener.textContent = "Open conflict";
  document.body.append(opener);
  opener.focus();
  const calls: string[] = [];
  const Harness = () => {
    const [current, setCurrent] = React.useState<typeof conflict | null>(conflict);
    return React.createElement(WebDavConflictDialog, {
      conflict: current,
      isBusy: false,
      onUseLocal: async () => { calls.push("local"); },
      onUseCloud: async () => { calls.push("cloud"); },
      onDismiss: () => { calls.push("dismiss"); setCurrent(null); },
    });
  };
  renderLocalized(React.createElement(Harness));

  const dialog = screen.getByRole("dialog", { name: "Choose which resume version to keep" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.match(dialog.textContent ?? "", /local-device/);
  assert.match(dialog.textContent ?? "", /cloud-device/);
  assert.ok(opener.closest("[aria-hidden='true']"), "background is hidden while modal is open");
  const dismiss = within(dialog).getByRole("button", { name: "Dismiss" });
  const useLocal = within(dialog).getByRole("button", { name: "Use local version" });
  const useCloud = within(dialog).getByRole("button", { name: "Use cloud version" });
  await waitFor(() => assert.ok(document.activeElement === dismiss));
  useCloud.focus();
  fireEvent.keyDown(useCloud, { key: "Tab" });
  assert.ok(document.activeElement === dismiss);
  dismiss.focus();
  fireEvent.keyDown(dismiss, { key: "Tab", shiftKey: true });
  assert.ok(document.activeElement === useCloud);
  assert.ok(useLocal);

  await user.keyboard("{Escape}");
  await waitFor(() => assert.equal(screen.queryByRole("dialog"), null));
  assert.deepEqual(calls, ["dismiss"]);
  await waitFor(() => assert.ok(document.activeElement === opener));
});

test("conflict choices are actionable and all conflict actions are disabled while busy", async () => {
  const user = userEvent.setup({ document });
  const calls: string[] = [];
  const props = {
    conflict,
    isBusy: false,
    onUseLocal: async () => { calls.push("local"); },
    onUseCloud: async () => { calls.push("cloud"); },
    onDismiss: () => { calls.push("dismiss"); },
  };
  const view = renderLocalized(React.createElement(WebDavConflictDialog, props));
  await user.click(screen.getByRole("button", { name: "Use local version" }));
  await user.click(screen.getByRole("button", { name: "Use cloud version" }));
  assert.deepEqual(calls, ["local", "cloud"]);

  view.rerender(React.createElement(
    NextIntlClientProvider,
    { locale: "en", messages: en },
    React.createElement(WebDavConflictDialog, { ...props, isBusy: true }),
  ));
  for (const name of ["Dismiss", "Use local version", "Use cloud version"]) {
    assert.equal(screen.getByRole("button", { name }).hasAttribute("disabled"), true);
  }
});

test("snapshot validation errors render only their localized safe messages", () => {
  const secret = "raw-server-body-password-and-url";
  const cases = [
    ["SNAPSHOT_VERSION", en.dashboard.settings.webdav.newerSnapshotError],
    ["SNAPSHOT_RESUME", en.dashboard.settings.webdav.corruptSnapshotError],
    ["SNAPSHOT_HASH", en.dashboard.settings.webdav.corruptSnapshotError],
  ] as const;
  for (const [code, message] of cases) {
    useWebDavStore.getState().setError({ code, status: null });
    const view = renderLocalized(React.createElement(WebDavSection));
    const alert = screen.getByRole("alert");
    assert.equal(alert.textContent, message);
    assert.doesNotMatch(alert.textContent ?? "", new RegExp(secret));
    view.unmount();
  }
});


test("conflict dates follow the active i18n locale explicitly", () => {
  const english = renderLocalized(React.createElement(WebDavConflictDialog, {
    conflict,
    isBusy: false,
    onUseLocal: async () => {},
    onUseCloud: async () => {},
    onDismiss: () => {},
  }));
  const englishTime = document.querySelector("time")?.textContent;
  english.unmount();
  const chinese = renderLocalized(React.createElement(WebDavConflictDialog, {
    conflict,
    isBusy: false,
    onUseLocal: async () => {},
    onUseCloud: async () => {},
    onDismiss: () => {},
  }), zh);
  const chineseTime = document.querySelector("time")?.textContent;

  assert.notEqual(englishTime, chineseTime);
  assert.equal(englishTime, new Date(conflict.local.updatedAt).toLocaleString("en"));
  assert.equal(chineseTime, new Date(conflict.local.updatedAt).toLocaleString("zh"));
});


test("Providers starts WebDAV once after either store hydration order and aborts on cleanup", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const order of ["settings-first", "resume-first"] as const) {
      cleanup();
      resetStores();
      useResumeStore.setState({ _hasHydrated: false });
      const signals: AbortSignal[] = [];
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") {
          const signal = init.signal as AbortSignal;
          signals.push(signal);
          return await new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const configured = {
        baseUrl: "https://dav.example.test",
        username: "alice",
        password: "secret",
        remoteDirectory: "/magic-resume/",
        autoSyncEnabled: true,
      };
      const view = renderLocalized(React.createElement(
        Providers,
        null,
        React.createElement("div", null, "child"),
      ));

      if (order === "settings-first") {
        await act(async () => { useWebDavStore.getState().setSettings(configured); });
        await act(async () => { useResumeStore.getState().setHasHydrated(true); });
      } else {
        await act(async () => { useResumeStore.getState().setHasHydrated(true); });
        await act(async () => { useWebDavStore.getState().setSettings(configured); });
      }
      await waitFor(() => assert.equal(signals.length, 1), { timeout: 2_000 });
      view.unmount();
      assert.equal(signals[0].aborted, true, order);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
