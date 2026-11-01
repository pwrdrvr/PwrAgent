import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type CDPSession } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

// Explicit local diagnostic mode only. The three-second recording and stream
// are bounded; raw traces contain fixture data and stay in ignored test output.
async function capturePerformance(session: CDPSession, output: string) {
  await session.send("Profiler.enable");
  await session.send("Profiler.start");
  const completed = new Promise<{ stream?: string; dataLossOccurred?: boolean }>((resolve) => {
    session.once("Tracing.tracingComplete", resolve);
  });
  await session.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      recordMode: "recordUntilFull",
      traceBufferSizeInKb: 8192,
      includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline",
        "disabled-by-default-devtools.timeline.stack", "v8.execute", "toplevel", "blink.user_timing"],
      excludedCategories: ["*"],
    },
  });
  let ended = false;
  const stop = async () => {
    if (ended) return;
    ended = true;
    await session.send("Tracing.end");
  };
  let stopTimer: ReturnType<typeof setTimeout>;
  const end = new Promise<void>((resolve, reject) => {
    stopTimer = setTimeout(() => { stop().then(resolve, reject); }, 3000);
  });
  // Failure before finish still has an owned cancellation path.
  void end.catch(() => {});
  const finish = async () => {
    await end;
    const result = await Promise.race([
      completed,
      new Promise<never>((_resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Trace transfer deadline")), 10_000);
        timeout.unref();
      }),
    ]);
    expect(result.dataLossOccurred).not.toBe(true);
    if (!result.stream) throw new Error("Missing performance stream");
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await session.send("IO.read", { handle: result.stream, size: 1024 * 1024 });
        const data = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        bytes += data.length;
        if (bytes > 64 * 1024 * 1024) throw new Error("Performance trace size limit");
        chunks.push(data);
        if (chunk.eof) break;
        if (data.length === 0) throw new Error("Performance stream made no progress");
      }
    } finally {
      await session.send("IO.close", { handle: result.stream });
    }
    const profile = await session.send("Profiler.stop");
    await writeFile(output, Buffer.concat(chunks));
    await writeFile(`${output}.cpuprofile`, JSON.stringify(profile.profile));
  };
  return {
    finish,
    cancel: async () => { clearTimeout(stopTimer); await stop().catch(() => {}); },
  };
}

test("tooltip ignores sibling streaming and still detects sibling layout movement", async () => {
  const testInfo = test.info();
  const app = await launchElectronApp({
    fixturePath: path.resolve(import.meta.dirname, "fixtures/context-rail-linked-directory-tooltips/replay.fixture.json"),
    windowSize: { width: 1280, height: 820 },
  });
  let session: CDPSession | undefined;
  let capture: Awaited<ReturnType<typeof capturePerformance>> | undefined;
  try {
    await app.window.getByRole("button", { name: /Linked directory tooltip thread/i }).first().click();
    const rail = app.window.getByRole("complementary", { name: "Thread context" });
    await rail.getByRole("tab", { name: "Linked projects" }).click();
    const anchor = rail.getByLabel("Path for PwrAgent", { exact: true });
    if (process.env.PWRAGENT_TOOLTIP_OBSERVER_DIAGNOSTICS === "1") {
      await anchor.evaluate((target) => {
        const diagnostics = { frames: [] as string[], sizes: [] as object[], activeFrame: "", source: "" };
        Object.assign(window, { tooltipBudgetDiagnostics: diagnostics });
        const request = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) => {
          const source = diagnostics.source;
          return request((time) => {
            diagnostics.activeFrame = source;
            try { callback(time); } finally { diagnostics.activeFrame = ""; }
          });
        };
        const NativeResizeObserver = ResizeObserver;
        window.ResizeObserver = class extends NativeResizeObserver {
          constructor(callback: ResizeObserverCallback) {
            super((entries, observer) => {
              for (const entry of entries) {
                if (entry.target === target && diagnostics.sizes.length < 8) {
                  diagnostics.sizes.push({
                    inlineSize: entry.borderBoxSize[0]?.inlineSize,
                    blockSize: entry.borderBoxSize[0]?.blockSize,
                    fontStatus: document.fonts.status,
                  });
                }
              }
              diagnostics.source = "ResizeObserver";
              try { callback(entries, observer); } finally { diagnostics.source = ""; }
            });
          }
        };
        const NativeMutationObserver = MutationObserver;
        window.MutationObserver = class extends NativeMutationObserver {
          constructor(callback: MutationCallback) {
            super((records, observer) => {
              diagnostics.source = "MutationObserver";
              try { callback(records, observer); } finally { diagnostics.source = ""; }
            });
          }
        };
      });
    }
    await anchor.focus();
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    await anchor.evaluate(async (target) => {
      const original = target.getBoundingClientRect.bind(target);
      const stream = document.createElement("div");
      stream.id = "tooltip-budget-stream";
      stream.style.cssText = "position:fixed;left:600px;top:400px;width:250px;height:100px;overflow:hidden;pointer-events:none";
      const text = document.createElement("p");
      stream.append(text);
      document.body.append(stream);
      // Own the actual finite mount animations; two frames alone can still
      // leave the rail's 220 ms slide and its rebaseline outstanding.
      const animations: Animation[] = [];
      for (let element: Element | null = target; element; element = element.parentElement) {
        animations.push(...element.getAnimations().filter((animation) =>
          animation.playState === "running"
          && Number.isFinite(animation.effect?.getComputedTiming().activeDuration),
        ));
      }
      await Promise.allSettled(animations.map((animation) => animation.finished));
      // Drain the native initial deliveries after the motion's completion.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      let reads = 0;
      const diagnostics = (window as unknown as { tooltipBudgetDiagnostics?: {
        activeFrame: string; frames: string[]; baseline?: object;
      } }).tooltipBudgetDiagnostics;
      target.getBoundingClientRect = () => {
        reads += 1;
        if (diagnostics && diagnostics.frames.length < 8) {
          diagnostics.frames.push(diagnostics.activeFrame || new Error().stack || "unknown");
        }
        const rect = original();
        if (diagnostics) diagnostics.baseline = { rect: rect.toJSON(), fontStatus: document.fonts.status };
        return rect;
      };
      Object.assign(window, { tooltipBudgetReads: () => reads });
    });
    if (process.env.PWRAGENT_TOOLTIP_PERFORMANCE_TRACE === "1") {
      session = await app.window.context().newCDPSession(app.window);
      capture = await capturePerformance(session, testInfo.outputPath("tooltip-performance.json"));
    }
    const reads = await app.window.evaluate(async () => {
      const stream = document.querySelector<HTMLElement>("#tooltip-budget-stream")!;
      performance.mark("tooltip-stream-start");
      for (let index = 0; index < 100; index += 1) {
        stream.firstChild!.textContent = "Contrived streamed content ".repeat(index % 20 + 1);
        stream.style.width = `${200 + index % 30}px`;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      performance.mark("tooltip-stream-end");
      return (window as unknown as { tooltipBudgetReads: () => number }).tooltipBudgetReads();
    });
    await capture?.finish();
    console.log(JSON.stringify({ tooltipStreaming: { deliveries: 100, anchorGeometryReads: reads } }));
    if (process.env.PWRAGENT_TOOLTIP_OBSERVER_DIAGNOSTICS === "1") console.log(JSON.stringify(await app.window.evaluate(() =>
      (window as unknown as { tooltipBudgetDiagnostics?: object }).tooltipBudgetDiagnostics,
    )));
    expect(reads).toBe(0);
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    // A sibling's descendants resize without mutating any observed ancestor
    // or resizing the anchor itself. Native intersection must detect the shift.
    await anchor.evaluate((target) => {
      const sibling = document.createElement("div");
      sibling.id = "tooltip-layout-sibling";
      sibling.style.display = "contents";
      const child = document.createElement("div");
      child.style.position = "absolute";
      sibling.append(child);
      target.parentElement!.insertBefore(sibling, target);
    });
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    await anchor.evaluate(() => {
      const child = document.querySelector<HTMLElement>("#tooltip-layout-sibling > div")!;
      child.style.position = "static";
      child.style.width = "20px";
      child.style.height = "50px";
    });
    await expect(app.window.getByRole("tooltip")).toHaveCount(0);
    await anchor.focus();
    // Focus may already belong to the anchor; tab away and back to re-open.
    await anchor.blur();
    await anchor.focus();
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    await anchor.evaluate((target) => { target.remove(); });
    await expect(app.window.getByRole("tooltip")).toHaveCount(0);
  } finally {
    await capture?.cancel();
    await session?.detach();
    await app.close();
  }
});
