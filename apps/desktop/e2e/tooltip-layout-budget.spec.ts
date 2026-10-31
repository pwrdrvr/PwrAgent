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
  const end = new Promise<void>((resolve, reject) => {
    setTimeout(() => { session.send("Tracing.end").then(() => resolve(), reject); }, 3000);
  });
  return async () => {
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
}

test("tooltip ignores sibling streaming and still detects sibling layout movement", async ({}, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(import.meta.dirname, "fixtures/context-rail-linked-directory-tooltips/replay.fixture.json"),
    windowSize: { width: 1280, height: 820 },
  });
  let session: CDPSession | undefined;
  try {
    await app.window.getByRole("button", { name: /Linked directory tooltip thread/i }).first().click();
    const rail = app.window.getByRole("complementary", { name: "Thread context" });
    await rail.getByRole("tab", { name: "Linked projects" }).click();
    const anchor = rail.getByLabel("Path for PwrAgent", { exact: true });
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
      // Let opening, native initial deliveries and fixture mount motion settle.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      let reads = 0;
      target.getBoundingClientRect = () => { reads += 1; return original(); };
      Object.assign(window, { tooltipBudgetReads: () => reads });
    });
    let finishCapture: (() => Promise<void>) | undefined;
    if (process.env.PWRAGENT_TOOLTIP_PERFORMANCE_TRACE === "1") {
      session = await app.window.context().newCDPSession(app.window);
      finishCapture = await capturePerformance(session, testInfo.outputPath("tooltip-performance.json"));
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
    await finishCapture?.();
    console.log(JSON.stringify({ tooltipStreaming: { deliveries: 100, anchorGeometryReads: reads } }));
    expect(reads).toBe(0);
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    // A sibling's descendants resize without mutating any observed ancestor
    // or resizing the anchor itself. Native intersection must detect the shift.
    await anchor.evaluate((target) => {
      const sibling = document.createElement("div");
      sibling.id = "tooltip-layout-sibling";
      sibling.append(document.createElement("div"));
      target.parentElement!.insertBefore(sibling, target);
    });
    await expect(app.window.getByRole("tooltip")).toBeVisible();
    await anchor.evaluate(() => {
      document.querySelector<HTMLElement>("#tooltip-layout-sibling > div")!.style.height = "50px";
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
    await session?.detach();
    await app.close();
  }
});
