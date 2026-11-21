import { EventEmitter } from "node:events";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { createChromiumTraceSession } from "../shell/diagnostics/chromium-trace-session";

const electron = vi.hoisted(() => ({ createView: vi.fn() }));
vi.mock("electron", () => ({
  WebContentsView: class {
    webContents = electron.createView();
  },
}));

it("includes existing pages in Chromium's initial trace producer set", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }),
    async (pageIds) => {
      const pages = pageIds.map((id) => ({ type: "page", targetId: String(id) }));
      const ownPage = { type: "page", targetId: "trace-owner" };
      const serviceWorker = { type: "service_worker", targetId: "worker" };
      const targetInfos = [ownPage, serviceWorker, ...pages];
      const attached = new Set<string>();
      let initialProducers = new Set<string>();
      const debuggerApi = Object.assign(new EventEmitter(), {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: () => true,
        async sendCommand(method: string, params?: { targetId: string }) {
          switch (method) {
            case "Target.getTargetInfo":
              return { targetInfo: ownPage };
            case "Target.setDiscoverTargets":
              for (const targetInfo of targetInfos) {
                debuggerApi.emit("message", {}, "Target.targetCreated", { targetInfo });
              }
              return {};
            case "Target.getTargets":
              return { targetInfos };
            case "Target.attachToTarget":
              if (!params) throw new Error("Missing targetId");
              await Promise.resolve();
              attached.add(params.targetId);
              return {};
            case "Tracing.start":
              // Chromium takes its initial producer set from the attached session tree.
              // A later attachment can change the filter without acknowledging producer startup.
              initialProducers = new Set(attached);
              return {};
            default:
              throw new Error(`Unexpected command ${method}`);
          }
        },
      });
      electron.createView.mockReturnValue({
        debugger: debuggerApi,
        isDestroyed: () => false,
        close: vi.fn(),
      });
      const session = createChromiumTraceSession();
      try {
        await session.start({
          recordMode: "recordContinuously",
          traceBufferSizeInKb: 1024,
          includedCategories: ["blink.user_timing"],
          excludedCategories: ["*"],
        });
        expect(initialProducers).toEqual(new Set(pages.map(({ targetId }) => targetId)));
      } finally {
        session.dispose();
      }
    },
  ), { examples: [[[1]]] });
});
