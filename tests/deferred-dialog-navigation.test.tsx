import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React, { StrictMode } from "react";
import { JSDOM } from "jsdom";
import { useDeferredDialogNavigation } from "../src/hooks/useDeferredDialogNavigation";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://magic-resume.test/",
  pretendToBeVisual: true,
});

for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
})) {
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

type Frame = { id: number; callback: FrameRequestCallback };
let nextFrameId = 1;
let frames: Frame[] = [];

window.requestAnimationFrame = (callback) => {
  const id = nextFrameId++;
  frames.push({ id, callback });
  return id;
};
window.cancelAnimationFrame = (id) => {
  frames = frames.filter((frame) => frame.id !== id);
};

const { cleanup, render } = await import("@testing-library/react");

interface HarnessProps {
  open: boolean;
  pendingId: string | null;
  onClear?: () => void;
  onNavigate: (id: string) => void;
}

function Harness({ open, pendingId, onClear = () => {}, onNavigate }: HarnessProps) {
  useDeferredDialogNavigation({
    isDialogOpen: open,
    pendingId,
    clearPendingId: onClear,
    navigate: onNavigate,
  });
  return null;
}

function flushAnimationFrame() {
  const queued = frames;
  frames = [];
  for (const frame of queued) frame.callback(0);
}

afterEach(() => {
  cleanup();
  frames = [];
});
after(() => dom.window.close());

test("waits until the dialog is closed and the next frame before navigating", () => {
  const calls: string[] = [];
  const view = render(
    <Harness open pendingId="resume-1" onNavigate={(id) => calls.push(id)} />,
  );
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 0);

  view.rerender(
    <Harness open={false} pendingId="resume-1" onNavigate={(id) => calls.push(id)} />,
  );
  assert.deepEqual(calls, []);
  assert.equal(frames.length, 1);

  flushAnimationFrame();
  assert.deepEqual(calls, ["resume-1"]);
});

test("clears the pending id before navigating", () => {
  const events: string[] = [];
  render(
    <Harness
      open={false}
      pendingId="resume-2"
      onClear={() => events.push("clear")}
      onNavigate={(id) => events.push(`navigate:${id}`)}
    />,
  );

  flushAnimationFrame();
  assert.deepEqual(events, ["clear", "navigate:resume-2"]);
});

test("uses fresh callbacks without rescheduling the queued frame", () => {
  const calls: string[] = [];
  const view = render(
    <Harness
      open={false}
      pendingId="resume-3"
      onClear={() => calls.push("old-clear")}
      onNavigate={() => calls.push("old-navigate")}
    />,
  );
  assert.equal(frames.length, 1);
  const scheduledFrameId = frames[0].id;

  view.rerender(
    <Harness
      open={false}
      pendingId="resume-3"
      onClear={() => calls.push("new-clear")}
      onNavigate={() => calls.push("new-navigate")}
    />,
  );
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, scheduledFrameId);

  flushAnimationFrame();
  assert.deepEqual(calls, ["new-clear", "new-navigate"]);
});

test("cancels queued navigation when unmounted", () => {
  const calls: string[] = [];
  const view = render(
    <Harness open={false} pendingId="resume-4" onNavigate={(id) => calls.push(id)} />,
  );
  assert.equal(frames.length, 1);

  view.unmount();
  assert.equal(frames.length, 0);
  flushAnimationFrame();
  assert.deepEqual(calls, []);
});

test("navigates exactly once across Strict Mode effects and rerenders", () => {
  const calls: string[] = [];
  const view = render(
    <StrictMode>
      <Harness open={false} pendingId="resume-5" onNavigate={(id) => calls.push(id)} />
    </StrictMode>,
  );
  assert.equal(frames.length, 1);

  view.rerender(
    <StrictMode>
      <Harness open={false} pendingId="resume-5" onNavigate={(id) => calls.push(id)} />
    </StrictMode>,
  );
  assert.equal(frames.length, 1);

  flushAnimationFrame();
  assert.deepEqual(calls, ["resume-5"]);
  assert.equal(frames.length, 0);
});
