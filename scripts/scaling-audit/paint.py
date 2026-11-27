"""Stage the native synthetic lens-switch control in an installed macOS lab checkout."""
import argparse
from contextlib import ExitStack
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("checkout", type=Path)
parser.add_argument("output", type=Path, help="fresh directory for one JSON file per Electron launch")
parser.add_argument("--repeats", type=int, default=1)
parser.add_argument("--list", action="store_true", help="verify discovery without building or launching Electron")
args = parser.parse_args()
if args.repeats < 1:
    parser.error("use a positive repeat count")
repo = args.checkout.resolve()
desktop = repo / "apps/desktop"
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=False)
with ExitStack() as cleanup:
    spec = desktop / "e2e/scaling-audit-paint.inspect.spec.ts"
    with spec.open("x") as target:
        cleanup.callback(spec.unlink, missing_ok=True)
        target.write((Path(__file__).parent / "historical/paint.ts").read_text())
    env = dict(os.environ, PWRAGENT_E2E_DISABLE_GPU="1",
               PWRAGENT_HOME=cleanup.enter_context(TemporaryDirectory(prefix="paint-audit-")))
    command = ["pnpm", "exec", "playwright", "test", "-c", "playwright.inspect.config.ts", spec.name, "--workers=1"]
    if args.list:
        subprocess.run([*command, "--list"], cwd=desktop, env=env, check=True)
    else:
        subprocess.run(["pnpm", "build"], cwd=desktop, env=env, check=True)
        for sample in range(args.repeats):
            sample_path = output / f"paint-{sample + 1}.json"
            subprocess.run(command, cwd=desktop, env=dict(env, AUDIT_PAINT_OUTPUT=str(sample_path)), check=True)
            if not sample_path.is_file():
                raise RuntimeError(f"Missing paint sample {sample_path}")
