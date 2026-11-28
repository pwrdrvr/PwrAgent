"""Run matched active and idle native Electron replays in the macOS E2E VM."""
import argparse
from contextlib import ExitStack
import json
import os
import shutil
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
REVISIONS = json.loads((HERE / "revisions.json").read_text())
REVISIONS["integrated"] = "4b4522025eb15a9988a14289e9a32b1260c37217"


def run(*command, cwd, env=None):
    subprocess.run(command, cwd=cwd, env=env, check=True)


def stage(desktop, clean):
    def add(relative, content):
        file = desktop / relative
        with file.open("x") as stream:
            stream.write(content)
        clean.callback(file.unlink)

    def replace(relative, old, new):
        file = desktop / relative
        source = file.read_text()
        if source.count(old) != 1:
            raise RuntimeError(f"{relative}: expected one staging anchor for {old}")
        clean.callback(file.write_text, source)
        file.write_text(source.replace(old, new, 1))

    add("e2e/active-paint.inspect.spec.ts", (HERE / "historical/active-paint.ts").read_text())
    add("src/main/testing/active-paint-owner.ts", (HERE / "historical/active-paint-owner.ts").read_text())
    replace("src/main/shell/index.ts", "import { startOwnerServices,",
            'import { installActivePaintAudit } from "../testing/active-paint-owner";\nimport { startOwnerServices,')
    replace("src/main/shell/index.ts", "    registerAppServerIpcHandlers();",
            "    installActivePaintAudit(ownerServices);\n    registerAppServerIpcHandlers();")
    owners = "src/main/owner-services.ts"
    source = (desktop / owners).read_text()
    replace(owners, 'import { createDesktopBackendRegistry }',
            'import { auditStackHold } from "./testing/active-paint-owner";\nimport { createDesktopBackendRegistry }')
    # Newer owners pass a stack observation to the reader. Keep it on the
    # production fallback and preserve the same synthetic hold across revisions.
    for parameters in ("review, observation", "review", "thread"):
        reader = f"getDesktopAppServerService().automationStackHold({parameters})"
        anchor = f"readReviewStackHold: ({parameters}) => {reader},"
        if anchor in source:
            review = parameters.split(", ", 1)[0]
            replace(owners, anchor, f"readReviewStackHold: ({parameters}) => auditStackHold({review}, () => {reader}),")
            break
    else:
        raise RuntimeError(f"{owners}: unrecognized review stack hold reader")
    client = "src/main/shell/testing/replay-client.ts"
    replace(client, "  async advance(params:", """  async emitAuditNotification(notification: AppServerNotification): Promise<void> {
    for (const listener of this.notificationListeners) await listener(notification);
  }

  async advance(params:""")
    replace(client, "      for (const listener of this.notificationListeners) {\n        await listener(step.notification);\n      }",
            "      await this.emitAuditNotification(step.notification);")
    replace("src/main/shell/testing/replay-runtime.ts", "  globalThis.__PWRAGENT_REPLAY_DRIVER__ = {", """  if (process.env.AUDIT_ACTIVE_PAINT === "1") {
    Object.assign(globalThis, {
      __auditReplayNotification: (notification: AppServerNotification) =>
        (getReplayClient(clients, { backend: "codex" }) as ReplayClient).emitAuditNotification(notification),
    });
  }
  globalThis.__PWRAGENT_REPLAY_DRIVER__ = {""")


def measure(checkout, output, args, revision):
    desktop = checkout / "apps/desktop"
    with ExitStack() as cleanup:
        stage(desktop, cleanup)
        home = cleanup.enter_context(TemporaryDirectory(prefix=".paint-home-", dir=checkout))
        env = dict(os.environ, PWRAGENT_E2E_DISABLE_GPU="1", PWRAGENT_HOME=home, TMPDIR=home)
        command = ["pnpm", "exec", "playwright", "test", "-c", "playwright.inspect.config.ts",
                   "active-paint.inspect.spec.ts", "--workers=1", "--retries=0", "--reporter=line"]
        if args.list:
            run(*command, "--list", cwd=desktop, env=env)
            return []
        run("pnpm", "build", cwd=desktop, env=env)
        failures = []
        for copies in args.copies:
            topology = output / f"topology-{copies}.json"
            run("node", "-e", """
              const [url, file, copies] = process.argv.slice(1);
              Promise.all([import(url), import('node:fs')]).then(([{generate}, fs]) =>
                fs.writeFileSync(file, JSON.stringify(generate({copies: Number(copies)}))));
            """, (HERE / "generate.mjs").as_uri(), str(topology), str(copies), cwd=desktop)
            for repeat in range(1, args.repeats + 1):
                # Alternate paired active and idle ordering between launches.
                scenarios = args.scenarios if repeat % 2 else list(reversed(args.scenarios))
                for scenario in scenarios:
                    case = dict(revision=revision, copies=copies, repeat=repeat, scenario=scenario, warm=args.warm,
                                cadence={lane: getattr(args, lane + "_ms") if scenario == "active" else 0
                                         for lane in ("status", "review", "inbound", "outbound")},
                                held=args.held if scenario == "active" else 0, queueDepth=args.queue_depth,
                                redeliveries=args.redeliveries, leadMs=args.lead_ms)
                    sample = output / f"{revision}-{copies}x-{repeat}-{scenario}.json"
                    print(f"Native active paint: {sample.name}", flush=True)
                    diagnostics = output / (sample.stem + "-diagnostics")
                    try:
                        run(*command, "--output", str(diagnostics), cwd=desktop,
                            env=dict(env, AUDIT_PAINT_CASE=json.dumps(case), AUDIT_PAINT_TOPOLOGY=str(topology),
                                     AUDIT_PAINT_OUTPUT=str(sample)))
                    except subprocess.CalledProcessError as error:
                        failures.append(f"{sample.name}: exit {error.returncode}")
                        continue
                    if sample.is_file():
                        shutil.rmtree(diagnostics, ignore_errors=True)
                    else:
                        failures.append(f"{sample.name}: missing sample")
        return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--checkout", type=Path, help="one already installed disposable checkout")
    parser.add_argument("--revisions", nargs="+", choices=sorted(REVISIONS), default=["v152", "latest", "integrated"])
    parser.add_argument("--copies", nargs="+", type=int, choices=[1, 2, 4], default=[1, 2, 4])
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--scenarios", nargs="+", choices=["idle", "active"], default=["idle", "active"])
    parser.add_argument("--warm", type=int, default=10)
    parser.add_argument("--status-ms", type=int, default=70)
    parser.add_argument("--review-ms", type=int, default=160)
    parser.add_argument("--inbound-ms", type=int, default=125)
    parser.add_argument("--outbound-ms", type=int, default=145)
    parser.add_argument("--held", type=int, default=64)
    parser.add_argument("--queue-depth", type=int, default=32)
    parser.add_argument("--redeliveries", type=int, default=8)
    parser.add_argument("--lead-ms", type=int, default=450)
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if min(args.repeats, args.warm, args.queue_depth, args.redeliveries) < 1:
        parser.error("repeats, warm samples, queue depth and redeliveries must be positive")
    if min(args.status_ms, args.review_ms, args.inbound_ms, args.outbound_ms, args.lead_ms) < 0 or not 0 <= args.held <= 64:
        parser.error("cadence and lead time must be nonnegative, with 0–64 held reviews")
    if "active" in args.scenarios and not any([args.status_ms, args.review_ms, args.inbound_ms, args.outbound_ms]):
        parser.error("active needs at least one nonzero event cadence")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    repo = HERE.parent.parent
    if args.checkout:
        checkout = args.checkout.resolve()
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=checkout, text=True).strip()
        failures = measure(checkout, output, args, commit)
        if failures:
            raise SystemExit("; ".join(failures))
        return
    errors = []
    for revision in args.revisions:
        checkout = output / f".checkout-{revision}"
        run("git", "worktree", "add", "--detach", str(checkout), REVISIONS[revision], cwd=repo)
        try:
            run("pnpm", "install", "--frozen-lockfile", cwd=checkout)
            errors.extend(measure(checkout, output, args, revision))
        except subprocess.CalledProcessError as error:
            errors.append(f"{revision}: exit {error.returncode}")
        finally:
            run("git", "worktree", "remove", "--force", str(checkout), cwd=repo)
    if errors:
        raise SystemExit("; ".join(errors))


if __name__ == "__main__":
    main()
