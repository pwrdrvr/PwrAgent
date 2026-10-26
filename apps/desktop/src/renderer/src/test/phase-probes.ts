import * as rtl from "@testing-library/react";
import { createElement, Profiler } from "react";
import { aroundEach } from "vitest";

import { probe, record } from "../../../test-setup/phase-probes";
export { probe } from "../../../test-setup/phase-probes";

const enabled = process.env.PWRAGENT_TEST_PHASES === "1";
if (enabled) {
  aroundEach(async (runTest) => {
    const getComputedStyle = window.getComputedStyle;
    window.getComputedStyle = (...args) => probe("computed-style", () => getComputedStyle(...args));
    try {
      await runTest();
    } finally {
      window.getComputedStyle = getComputedStyle;
    }
  });
}

function queries<T extends object>(value: T): T {
  if (!enabled) return value;
  return new Proxy(value, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver);
      if (typeof method !== "function" || typeof key !== "string" || !/^(get|query|find).*By/.test(key)) return method;
      return (...args: unknown[]) => probe(key.startsWith("find") ? "find" : "query", () => Reflect.apply(method, target, args));
    },
  });
}

export * from "@testing-library/react";
export const screen = queries(rtl.screen);
export const within: typeof rtl.within = (...args) => queries(rtl.within(...args));
export const render = new Proxy(rtl.render, {
  apply(target, receiver, args) {
    const [ui, options] = args;
    return queries(probe("render", () => Reflect.apply(target, receiver, [enabled
      ? createElement(Profiler, { id: "test", onRender: (_id, _phase, duration) => record("react", duration) }, ui)
      : ui, options])));
  },
});
export const renderHook = new Proxy(rtl.renderHook, {
  apply: (target, receiver, args) => probe("render-hook", () => Reflect.apply(target, receiver, args)),
});
export const waitFor: typeof rtl.waitFor = (callback, options) =>
  probe("wait", () => rtl.waitFor(() => probe("wait-callback", callback), options));
