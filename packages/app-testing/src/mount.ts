import { resetApp } from "@everyos/app-sdk";
import { INIT_TYPE, PROTOCOL } from "@everyos/app-sdk/protocol";
import { MOCK_LABEL, MockHost, type MockHostOptions, type PortLike } from "./mock-host.ts";

/**
 * Runs `createApp()` against a MOCK host in a test DOM (happy-dom, jsdom) or a plain page: the
 * window is made to look framed, and the mock greets it like the desktop would. Call before the
 * app connects; `unmount()` restores the window.
 */
export function mountMockHost(options: MockHostOptions = {}): MockHost & { unmount(): void } {
  resetApp();
  const host = new MockHost(options);
  const fakeParent = { label: MOCK_LABEL, postMessage: () => undefined };
  const original = Object.getOwnPropertyDescriptor(window, "parent");
  Object.defineProperty(window, "parent", { configurable: true, get: () => fakeParent });
  const channel = new MessageChannel();
  host.connect(channel.port1 as unknown as PortLike);
  // The greeting goes out once the app listens for it (whenever its code loads), like a frame's.
  let greeted = false;
  const greet = () => {
    if (greeted) return;
    greeted = true;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: INIT_TYPE, protocol: PROTOCOL },
        source: fakeParent as unknown as Window,
        ports: [channel.port2],
      }),
    );
  };
  const addEventListener = window.addEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    ...rest: [EventListenerOrEventListenerObject, never]
  ) => {
    addEventListener(type, ...rest);
    if (type === "message") setTimeout(greet);
  }) as typeof window.addEventListener;
  return Object.assign(host, {
    unmount() {
      window.addEventListener = addEventListener;
      host.disconnect();
      resetApp();
      if (original) Object.defineProperty(window, "parent", original);
      else delete (window as { parent?: unknown }).parent;
    },
  });
}

/**
 * Connects a MOCK host to an app document in an `<iframe>` (the developer page of
 * `everyos-app dev`): on every load, a fresh channel, like the desktop.
 */
export function attachMockHost(frame: HTMLIFrameElement, options: MockHostOptions = {}): MockHost {
  const host = new MockHost(options);
  frame.addEventListener("load", () => {
    const channel = new MessageChannel();
    host.connect(channel.port1 as unknown as PortLike);
    frame.contentWindow?.postMessage({ type: INIT_TYPE, protocol: PROTOCOL }, "*", [channel.port2]);
  });
  return host;
}
