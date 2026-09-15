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
  "jianguoyunAuthError", "proxyProtocolError", "diagnosticLabel", "httpStatusLabel",
  "forbiddenError", "networkError", "timeoutError", "directoryError", "quotaError",
  "corruptSnapshotError", "newerSnapshotError", "unknownError", "perResumeJsonDescription",
  "credentialsLocalDescription", "clearKeepsFilesDescription", "syncedResumeCount", "conflictTitle",
  "conflictBody", "bothModified", "deleteVsModify", "localUpdatedAt", "remoteUpdatedAt",
  "notAvailable", "keepLocal", "useCloud",
].sort();

const renderLocalized = (child: React.ReactElement, messages: typeof en = en) =>
  render(React.createElement(
    NextIntlClientProvider,
    { locale: messages === zh ? "zh" : "en", messages },
    child,
  ));

const resetStores = () => {
  useWebDavStore.getState().clearCredentials();
  useWebDavStore.setState({ conflicts: [], syncedResumeCount: 0, lastSyncedAt: null });
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

test("newly hydrated settings expose labeled controls and default automatic sync on", async () => {
  const originalStorage = useWebDavStore.persist.getOptions().storage;
  try {
    useWebDavStore.persist.setOptions({
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    });
    resetStores();
    await act(async () => { await useWebDavStore.persist.rehydrate(); });

    renderLocalized(React.createElement(WebDavSection));

    assert.equal(screen.getByLabelText("Server URL").tagName, "INPUT");
    assert.equal(screen.getByLabelText("Username").tagName, "INPUT");
    assert.equal(screen.getByLabelText("Password").getAttribute("type"), "password");
    assert.equal(screen.getByLabelText("Remote directory").tagName, "INPUT");
    assert.equal(screen.getByRole("switch", { name: "Automatically sync changes" }).getAttribute("aria-checked"), "true");
  } finally {
    useWebDavStore.persist.setOptions({ storage: originalStorage });
  }
});

test("a hydrated persisted false renders automatic sync disabled", async () => {
  const originalStorage = useWebDavStore.persist.getOptions().storage;
  try {
    useWebDavStore.persist.setOptions({
      storage: {
        getItem: () => ({
          state: {
            settings: {
              baseUrl: "https://dav.example.test/root",
              username: "alice",
              password: "app-password",
              remoteDirectory: "/magic-resume/",
              autoSyncEnabled: false,
            },
            deviceId: "hydrated-device",
          },
          version: 0,
        }),
        setItem: () => {},
        removeItem: () => {},
      },
    });
    await act(async () => { await useWebDavStore.persist.rehydrate(); });

    renderLocalized(React.createElement(WebDavSection));

    assert.equal(screen.getByRole("switch", { name: "Automatically sync changes" }).getAttribute("aria-checked"), "false");
  } finally {
    useWebDavStore.persist.setOptions({ storage: originalStorage });
  }
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

  const serverUrl = screen.getByLabelText("Server URL");
  await user.click(serverUrl);
  await user.paste("https://dav.jianguoyun.com/dav\u200c");
  await user.type(screen.getByLabelText("Username"), "  alice  ");
  await user.type(screen.getByLabelText("Password"), " secret ");
  await user.clear(screen.getByLabelText("Remote directory"));
  await user.type(screen.getByLabelText("Remote directory"), " resumes ");
  assert.equal(useWebDavStore.getState().settings.baseUrl, "");

  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => assert.equal(calls.length, 1));
  const normalized = {
    baseUrl: "https://dav.jianguoyun.com/dav/",
    username: "alice",
    password: " secret ",
    remoteDirectory: "/resumes/",
    autoSyncEnabled: true,
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

test("ordinary WebDAV URLs keep legacy trailing-slash normalization in settings", async () => {
  resetStores();
  const user = userEvent.setup({ document });
  const calls: unknown[] = [];
  const controller = {
    testConnection: async () => { calls.push(useWebDavStore.getState().settings); },
    syncNow: async () => {},
    resolveConflict: async () => {},
  };
  renderLocalized(React.createElement(WebDavSection, { controllerProvider: () => controller }));

  await user.type(screen.getByLabelText("Server URL"), "https://dav.example.test/root///");
  await user.click(screen.getByRole("button", { name: "Test connection" }));
  await waitFor(() => assert.equal(calls.length, 1));

  assert.equal((calls[0] as { baseUrl: string }).baseUrl, "https://dav.example.test/root");
});

test("invalid URL normalization reports a safe localized error without calling the controller", async () => {
  resetStores();
  const user = userEvent.setup({ document });
  const unsafeInput = "https://dav.examp\u200cle.test/private-password";
  let providerCalls = 0;
  renderLocalized(React.createElement(WebDavSection, {
    controllerProvider: () => {
      providerCalls += 1;
      return {
        testConnection: async () => {},
        syncNow: async () => {},
        resolveConflict: async () => {},
      };
    },
  }));

  await user.type(screen.getByLabelText("Server URL"), unsafeInput);
  await user.click(screen.getByRole("button", { name: "Test connection" }));

  await waitFor(() => assert.ok(screen.getByRole("alert")));
  assert.equal(providerCalls, 0);
  assert.equal(useWebDavStore.getState().settings.baseUrl, "");
  assert.deepEqual(useWebDavStore.getState().error, { code: "UNKNOWN", status: null });
  assert.match(screen.getByRole("alert").textContent ?? "", /The WebDAV operation failed.*Diagnostic code: WD-CLIENT-UNKNOWN/);
  assert.doesNotMatch(screen.getByRole("alert").textContent ?? "", /private-password|HTTP/);
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
  resumeId: "full-id",
  title: "产品经理简历",
  kind: "both-modified" as const,
  localUpdatedAt: "2026-09-12T08:00:00.000Z",
  remoteUpdatedAt: "2026-09-12T09:00:00.000Z",
  local: null,
  remoteEntry: null,
};

test("conflict dialog traps focus and Escape keeps the unresolved conflict visible", async () => {
  const user = userEvent.setup({ document });
  const calls: string[] = [];
  renderLocalized(React.createElement(WebDavConflictDialog, {
    conflict,
    isBusy: false,
    onKeepLocal: async () => { calls.push("local"); },
    onUseCloud: async () => { calls.push("cloud"); },
  }));

  const dialog = screen.getByRole("dialog", { name: "Resolve resume sync conflict" });
  assert.equal(dialog.getAttribute("aria-modal"), "true");
  assert.match(dialog.textContent ?? "", /产品经理简历/);
  const keepLocal = within(dialog).getByRole("button", { name: "Keep local version" });
  const useCloud = within(dialog).getByRole("button", { name: "Use cloud version" });
  useCloud.focus();
  fireEvent.keyDown(useCloud, { key: "Tab" });
  assert.ok(document.activeElement === keepLocal);

  await user.keyboard("{Escape}");
  assert.ok(screen.getByRole("dialog", { name: "Resolve resume sync conflict" }));
  assert.deepEqual(calls, []);
});

test("conflict choices identify the resume and all conflict actions are disabled while busy", async () => {
  const user = userEvent.setup({ document });
  const calls: Array<[string, string]> = [];
  const props = {
    conflict,
    isBusy: false,
    onKeepLocal: async (resumeId: string) => { calls.push(["local", resumeId]); },
    onUseCloud: async (resumeId: string) => { calls.push(["cloud", resumeId]); },
  };
  const view = renderLocalized(React.createElement(WebDavConflictDialog, props));
  await user.click(screen.getByRole("button", { name: "Keep local version" }));
  await user.click(screen.getByRole("button", { name: "Use cloud version" }));
  assert.deepEqual(calls, [["local", "full-id"], ["cloud", "full-id"]]);

  view.rerender(React.createElement(
    NextIntlClientProvider,
    { locale: "en", messages: en },
    React.createElement(WebDavConflictDialog, { ...props, isBusy: true }),
  ));
  for (const name of ["Keep local version", "Use cloud version"]) {
    assert.equal(screen.getByRole("button", { name }).hasAttribute("disabled"), true);
  }
});

test("Jianguoyun proxy failures render localized safe diagnostics", () => {
  useWebDavStore.getState().setSettings({ baseUrl: "https://dav.jianguoyun.com/dav/" });
  useWebDavStore.getState().setError({ code: "UNKNOWN", status: 400 });
  renderLocalized(React.createElement(WebDavSection), zh);

  const alert = screen.getByRole("alert");
  assert.match(alert.textContent ?? "", /请强制刷新页面/);
  assert.match(alert.textContent ?? "", /诊断码：WD-PROXY-400/);
  assert.match(alert.textContent ?? "", /HTTP 400/);
});

test("authentication guidance names Jianguoyun's third-party app password only for the exact provider", () => {
  useWebDavStore.getState().setSettings({ baseUrl: "https://dav.jianguoyun.com/dav" });
  useWebDavStore.getState().setError({ code: "AUTH", status: 401 });
  const jianguoyun = renderLocalized(React.createElement(WebDavSection));

  const jianguoyunAlert = screen.getByRole("alert").textContent ?? "";
  assert.match(jianguoyunAlert, /third-party app password.*Jianguoyun.*Diagnostic code: WD-AUTH-401.*HTTP 401/);
  assert.match(
    zh.dashboard.settings.webdav.jianguoyunAuthError,
    /坚果云“账户信息 → 安全选项 → 第三方应用管理”.*第三方应用密码.*不是登录密码/,
  );
  jianguoyun.unmount();

  useWebDavStore.getState().setSettings({ baseUrl: "https://dav.example.test/root" });
  useWebDavStore.getState().setError({ code: "AUTH", status: 401 });
  renderLocalized(React.createElement(WebDavSection));
  const genericAlert = screen.getByRole("alert").textContent ?? "";
  assert.match(genericAlert, /Authentication failed.*Diagnostic code: WD-AUTH-401.*HTTP 401/);
  assert.doesNotMatch(genericAlert, /Jianguoyun|third-party/);
});

test("diagnostic alerts expose only allowlisted metadata", () => {
  const unsafeValues = [
    "private-user-marker",
    "submitted-password-marker",
    "Bearer authorization-marker",
    "request-body-marker",
    "upstream-response-marker",
    "query-secret-marker",
    "raw-exception-marker",
  ];
  const cases = [
    { code: "AUTH", status: 401, diagnosticCode: "WD-AUTH-401", http: "HTTP 401" },
    { code: "SERVER", status: 502, diagnosticCode: "WD-UPSTREAM-502", http: "HTTP 502" },
    { code: "UNKNOWN", status: null, diagnosticCode: "WD-CLIENT-UNKNOWN", http: null },
  ] as const;

  for (const { code, status, diagnosticCode, http } of cases) {
    useWebDavStore.getState().setError({
      code,
      status,
      username: unsafeValues[0],
      password: unsafeValues[1],
      Authorization: unsafeValues[2],
      requestBody: unsafeValues[3],
      responseBody: unsafeValues[4],
      url: `https://dav.example.test/root?token=${unsafeValues[5]}`,
      rawError: new Error(unsafeValues[6]),
    });
    const view = renderLocalized(React.createElement(WebDavSection));
    const text = screen.getByRole("alert").textContent ?? "";
    assert.match(text, new RegExp(`Diagnostic code: ${diagnosticCode}`));
    if (http) assert.match(text, new RegExp(http));
    else assert.doesNotMatch(text, /HTTP/);
    assert.doesNotMatch(text, /Authorization/);
    for (const unsafeValue of unsafeValues) assert.doesNotMatch(text, new RegExp(unsafeValue));
    view.unmount();
  }
});

test("snapshot validation errors render only their localized safe messages", () => {
  const secret = "raw-server-body-password-and-url";
  const cases = [
    ["SNAPSHOT_VERSION", en.dashboard.settings.webdav.newerSnapshotError, "WD-SNAPSHOT-VERSION"],
    ["SNAPSHOT_RESUME", en.dashboard.settings.webdav.corruptSnapshotError, "WD-SNAPSHOT-CORRUPT"],
    ["SNAPSHOT_HASH", en.dashboard.settings.webdav.corruptSnapshotError, "WD-SNAPSHOT-CORRUPT"],
  ] as const;
  for (const [code, message, diagnosticCode] of cases) {
    useWebDavStore.getState().setError({ code, status: null });
    const view = renderLocalized(React.createElement(WebDavSection));
    const text = screen.getByRole("alert").textContent ?? "";
    assert.match(text, new RegExp(`${message}Diagnostic code: ${diagnosticCode}`));
    assert.doesNotMatch(text, new RegExp(`${secret}|HTTP`));
    view.unmount();
  }
});


test("conflict dates follow the active i18n locale explicitly", () => {
  const english = renderLocalized(React.createElement(WebDavConflictDialog, {
    conflict,
    isBusy: false,
    onKeepLocal: async () => {},
    onUseCloud: async () => {},
  }));
  const englishTime = document.querySelector("time")?.textContent;
  english.unmount();
  const chinese = renderLocalized(React.createElement(WebDavConflictDialog, {
    conflict,
    isBusy: false,
    onKeepLocal: async () => {},
    onUseCloud: async () => {},
  }), zh);
  const chineseTime = document.querySelector("time")?.textContent;

  assert.notEqual(englishTime, chineseTime);
  assert.equal(englishTime, new Date(conflict.localUpdatedAt).toLocaleString("en"));
  assert.equal(chineseTime, new Date(conflict.localUpdatedAt).toLocaleString("zh"));
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


test("actual Chinese settings resolves the named resume and keeps unresolved conflicts open on Escape", async () => {
  const user = userEvent.setup({ document });
  const productResume = {
    resumeId: "full-id",
    title: "产品经理简历",
    kind: "both-modified" as const,
    localUpdatedAt: "2026-09-12T08:00:00.000Z",
    remoteUpdatedAt: "2026-09-12T09:00:00.000Z",
    local: null,
    remoteEntry: null,
  };
  const resolveCalls: Array<{ resumeId: string; resolution: string }> = [];
  useWebDavStore.setState({
    settings: {
      baseUrl: "https://dav.example.test/path?private=secret",
      username: "alice",
      password: "password-should-not-render",
      remoteDirectory: "/magic-resume/",
      autoSyncEnabled: true,
    },
    conflicts: [productResume],
    syncedResumeCount: 3,
    lastSyncedAt: "2026-09-12T10:00:00.000Z",
    status: "success",
    error: null,
    warning: null,
  } as any);
  const controller = {
    testConnection: async () => {},
    syncNow: async () => {},
    dismissConflict: () => {},
    resolveConflict: async (resumeId: string, resolution: string) => {
      resolveCalls.push({ resumeId, resolution });
    },
  };

  renderLocalized(React.createElement(WebDavSection, { controllerProvider: () => controller as any }), zh);

  assert.match(screen.getByText("产品经理简历").textContent ?? "", /产品经理简历/);
  assert.ok(screen.getByText("共同步 3 份简历"));
  assert.ok(screen.getByText(/每份简历保存为一个 JSON 文件/));
  await user.keyboard("{Escape}");
  assert.ok(screen.getByRole("dialog"), "Escape must not hide an unresolved conflict");
  await user.click(screen.getByRole("button", { name: "保留本地版本" }));
  assert.deepEqual(resolveCalls, [{ resumeId: "full-id", resolution: "keep-local" }]);
  for (const role of ["status", "alert"] as const) {
    const message = screen.queryByRole(role)?.textContent ?? "";
    assert.doesNotMatch(message, /password-should-not-render|private=secret/);
  }
});
