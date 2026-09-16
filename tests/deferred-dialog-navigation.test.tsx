import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import React, { StrictMode, useEffect } from "react";
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

const NativeMessageChannel = globalThis.MessageChannel;
let scheduledChannels = 0;
let scheduledFrames = 0;

class TrackingMessageChannel {
  constructor() {
    scheduledChannels += 1;
    return new NativeMessageChannel();
  }
}

Object.defineProperty(globalThis, "MessageChannel", {
  configurable: true,
  writable: true,
  value: TrackingMessageChannel,
});
window.requestAnimationFrame = () => {
  scheduledFrames += 1;
  return scheduledFrames;
};
window.cancelAnimationFrame = () => {};

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

const flushAsyncTask = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  cleanup();
  scheduledChannels = 0;
  scheduledFrames = 0;
  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    writable: true,
    value: TrackingMessageChannel,
  });
  Reflect.deleteProperty(document, "visibilityState");
});
after(() => dom.window.close());

test("waits until the dialog is closed and a later async task before navigating", async () => {
  const calls: string[] = [];
  const view = render(
    <Harness open pendingId="resume-1" onNavigate={(id) => calls.push(id)} />,
  );
  assert.deepEqual(calls, []);
  assert.equal(scheduledChannels, 0);

  view.rerender(
    <Harness open={false} pendingId="resume-1" onNavigate={(id) => calls.push(id)} />,
  );
  assert.deepEqual(calls, []);
  assert.equal(scheduledChannels, 1);

  await flushAsyncTask();
  assert.deepEqual(calls, ["resume-1"]);
});

test("clears the pending id before navigating", async () => {
  const events: string[] = [];
  render(
    <Harness
      open={false}
      pendingId="resume-2"
      onClear={() => events.push("clear")}
      onNavigate={(id) => events.push(`navigate:${id}`)}
    />,
  );

  await flushAsyncTask();
  assert.deepEqual(events, ["clear", "navigate:resume-2"]);
});

test("uses fresh callbacks without rescheduling the queued task", async () => {
  const calls: string[] = [];
  const view = render(
    <Harness
      open={false}
      pendingId="resume-3"
      onClear={() => calls.push("old-clear")}
      onNavigate={() => calls.push("old-navigate")}
    />,
  );
  assert.equal(scheduledChannels, 1);

  view.rerender(
    <Harness
      open={false}
      pendingId="resume-3"
      onClear={() => calls.push("new-clear")}
      onNavigate={() => calls.push("new-navigate")}
    />,
  );
  assert.equal(scheduledChannels, 1);

  await flushAsyncTask();
  assert.deepEqual(calls, ["new-clear", "new-navigate"]);
});

test("cancels queued navigation when unmounted", async () => {
  const calls: string[] = [];
  const view = render(
    <Harness open={false} pendingId="resume-4" onNavigate={(id) => calls.push(id)} />,
  );
  assert.equal(scheduledChannels, 1);

  view.unmount();
  await flushAsyncTask();
  assert.deepEqual(calls, []);
});

test("navigates exactly once across Strict Mode effects and rerenders", async () => {
  const calls: string[] = [];
  const view = render(
    <StrictMode>
      <Harness open={false} pendingId="resume-5" onNavigate={(id) => calls.push(id)} />
    </StrictMode>,
  );
  assert.equal(scheduledChannels, 2);

  view.rerender(
    <StrictMode>
      <Harness open={false} pendingId="resume-5" onNavigate={(id) => calls.push(id)} />
    </StrictMode>,
  );
  assert.equal(scheduledChannels, 2);

  await flushAsyncTask();
  await flushAsyncTask();
  assert.deepEqual(calls, ["resume-5"]);
});

test("navigates after the real dialog unmounts while hidden RAF never fires", async () => {
  const events: string[] = [];
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });

  function Dialog() {
    useEffect(() => () => {
      events.push("dialog-unmounted");
    }, []);
    return <div role="dialog" />;
  }

  function ImportHarness({ open }: { open: boolean }) {
    useDeferredDialogNavigation({
      isDialogOpen: open,
      pendingId: "resume-hidden",
      clearPendingId: () => events.push("clear"),
      navigate: (id) => events.push(`navigate:${id}`),
    });
    return open ? <Dialog /> : null;
  }

  const view = render(<ImportHarness open />);
  view.rerender(<ImportHarness open={false} />);

  assert.deepEqual(events, ["dialog-unmounted"]);
  assert.equal(scheduledFrames, 0);

  await flushAsyncTask();
  assert.deepEqual(events, [
    "dialog-unmounted",
    "clear",
    "navigate:resume-hidden",
  ]);

  await flushAsyncTask();
  assert.equal(
    events.filter((event) => event === "navigate:resume-hidden").length,
    1,
  );
});

test("uses an asynchronous cancellable microtask fallback without MessageChannel", async () => {
  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    writable: true,
    value: undefined,
  });
  const calls: string[] = [];
  const completed = render(
    <Harness open={false} pendingId="resume-fallback" onNavigate={(id) => calls.push(id)} />,
  );

  assert.deepEqual(calls, []);
  await Promise.resolve();
  assert.deepEqual(calls, ["resume-fallback"]);
  completed.unmount();

  const cancelled = render(
    <Harness open={false} pendingId="resume-cancelled" onNavigate={(id) => calls.push(id)} />,
  );
  cancelled.unmount();
  await Promise.resolve();
  assert.deepEqual(calls, ["resume-fallback"]);
});
