import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React from "react";
import { JSDOM } from "jsdom";
import { register } from "node:module";
import en from "../src/i18n/locales/en.json";

const cssLoader = `export async function load(url, context, nextLoad) {
  if (url.endsWith("?url")) {
    return { format: "module", shortCircuit: true, source: "export default 'test-asset-url';" };
  }
  if (/\\.(?:css|scss|svg)(?:$|\\?)/.test(url)) {
    return { format: "module", shortCircuit: true, source: "export default {};" };
  }
  return nextLoad(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(cssLoader)}`, import.meta.url);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://magic-resume.test/",
  pretendToBeVisual: true,
});
const browserGlobals = {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  SVGElement: dom.window.SVGElement,
  HTMLInputElement: dom.window.HTMLInputElement,
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
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  writable: true,
  value: true,
});
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
globalThis.requestAnimationFrame = (callback) =>
  setTimeout(callback, 0) as unknown as number;
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

class SuccessfulImage {
  crossOrigin = "";
  onload: null | (() => void) = null;
  onerror: null | (() => void) = null;

  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}
Object.defineProperty(globalThis, "Image", {
  configurable: true,
  writable: true,
  value: SuccessfulImage,
});

const testingLibrary = await import("@testing-library/react");
const { cleanup, fireEvent, render, screen, waitFor } = testingLibrary;
const [
  { NextIntlClientProvider },
  { default: AIPolishDialog },
  { default: PhotoConfigDrawer },
  { useAIConfigStore },
  { useGrammarStore },
  { requestPdfImport },
  { getRouter },
  { createAppHistory },
] = await Promise.all([
  import("../src/i18n/compat/client"),
  import("../src/components/shared/ai/AIPolishDialog"),
  import("../src/components/shared/PhotoConfigDrawer"),
  import("../src/store/useAIConfigStore"),
  import("../src/store/useGrammarStore"),
  import("../src/lib/pdf-import-client"),
  import("../src/router"),
  import("../src/config/runtime-endpoints"),
]);

const originalFetch = globalThis.fetch;
const apiBase =
  "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume";

function setMiaobiRuntime() {
  window.__MAGIC_RESUME_RUNTIME__ = {
    platform: "miaobi",
    apiFunctionUrl: apiBase,
    assetBaseUrl: "https://static.solutionsuite.cn/magic-resume/",
  };
}

function renderLocalized(child: React.ReactElement) {
  return render(
    React.createElement(
      NextIntlClientProvider,
      { locale: "en", messages: en },
      child,
    ),
  );
}

function configureTextModel() {
  useAIConfigStore.setState({
    models: [
      {
        id: "text-model",
        provider: "qwen",
        protocol: "chat-completions",
        name: "Text model",
        apiKey: "test-key",
        model: "qwen-test",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        supportsPdf: false,
      },
    ],
    textModelId: "text-model",
    pdfModelId: null,
  });
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(window, "__MAGIC_RESUME_RUNTIME__");
  window.history.replaceState(null, "", "/");
  useAIConfigStore.setState({ models: [], textModelId: null, pdfModelId: null });
  useGrammarStore.setState({ errors: [], isChecking: false });
  document.body.replaceChildren();
});
after(() => dom.window.close());

test("router leaves browser history as the default and uses hash navigation for Miaobi", async () => {
  const defaultRouter = getRouter();
  assert.equal(defaultRouter.options.history, undefined);

  const miaobiRouter = getRouter({ platform: "miaobi" });
  const miaobiHistory = miaobiRouter.options.history;
  assert.ok(miaobiHistory);
  miaobiHistory.push("/resumes");
  await Promise.resolve();
  assert.equal(window.location.pathname, "/");
  assert.equal(window.location.hash, "#/resumes");
});

test("runtime history uses browser URLs by default and hash URLs for Miaobi", async () => {
  const browserHistory = createAppHistory();
  browserHistory.push("/settings");
  await Promise.resolve();
  assert.equal(window.location.pathname, "/settings");
  assert.equal(window.location.hash, "");

  window.history.replaceState(null, "", "/");
  setMiaobiRuntime();
  const hashHistory = createAppHistory();
  hashHistory.push("/settings");
  await Promise.resolve();
  assert.equal(window.location.pathname, "/");
  assert.equal(window.location.hash, "#/settings");
});

test("grammar check sends its real request through the Miaobi endpoint", async () => {
  setMiaobiRuntime();
  configureTextModel();
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return Response.json({ choices: [{ message: { content: '{"errors":[]}' } }] });
  }) as typeof fetch;

  await useGrammarStore.getState().checkGrammar("A sentence");

  assert.equal(
    requestedUrl,
    "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=%2Fapi%2Fgrammar",
  );
});

test("AI polish sends its real request through the Miaobi endpoint", async () => {
  setMiaobiRuntime();
  configureTextModel();
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response("Updated resume");
  }) as typeof fetch;
  renderLocalized(
    React.createElement(AIPolishDialog, {
      open: true,
      onOpenChange: () => {},
      content: "Original resume",
      onApply: () => {},
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Start polish" }));

  await waitFor(() =>
    assert.equal(
      requestedUrl,
      "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=%2Fapi%2Fpolish",
    ),
  );
});

test("PDF import sends its real request through the Miaobi endpoint", async () => {
  setMiaobiRuntime();
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return Response.json({ resume: { title: "Imported" }, warnings: [] });
  }) as typeof fetch;

  await requestPdfImport(
    {
      provider: "qwen",
      protocol: "chat-completions",
      apiKey: "test-key",
      model: "qwen-vl-test",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    ["data:image/png;base64,aGVsbG8="],
  );

  assert.equal(
    requestedUrl,
    "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=%2Fapi%2Fresume-import",
  );
});

test("photo drawer resolves its default asset and proxy request through Miaobi", async () => {
  setMiaobiRuntime();
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    requestedUrls.push(String(input));
    return new Response(null, {
      status: 200,
      headers: { "content-length": "100" },
    });
  }) as typeof fetch;
  renderLocalized(
    React.createElement(PhotoConfigDrawer, {
      isOpen: true,
      photo: "/avatar.png",
      onClose: () => {},
      onPhotoChange: () => {},
      onConfigChange: () => {},
    }),
  );

  await waitFor(() =>
    assert.equal(
      screen.getByAltText("Profile").getAttribute("src"),
      "https://static.solutionsuite.cn/magic-resume/avatar.png",
    ),
  );
  fireEvent.change(screen.getByPlaceholderText("Enter image link"), {
    target: { value: "https://images.example.test/photo.png" },
  });

  await waitFor(() =>
    assert.deepEqual(requestedUrls, [
      "https://magic.solutionsuite.cn/api/faas/shared?tenant=resume&__path=%2Fapi%2Fproxy%2Fimage%3Furl%3Dhttps%253A%252F%252Fimages.example.test%252Fphoto.png",
    ]),
  );
});
