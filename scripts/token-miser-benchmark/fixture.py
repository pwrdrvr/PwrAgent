"""Create a disposable noisy header regression. Never run in an existing directory."""
import argparse
import json
from pathlib import Path
import subprocess


def create(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    def git(*args):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)
    git("init", "--quiet")
    css = root / "headers.css"
    def stylesheet(position, color):
        rows = [f".row-{i} {{ color: {color}; }}" for i in range(1600)]
        return f"thead {{ position: {position}; top: 7px; }}\n" + "\n".join(rows) + "\n"
    css.write_text(stylesheet("sticky", "navy"))
    git("add", "--", "headers.css")
    css.write_text(stylesheet("static", "teal"))
    for name, position in [("passing", "static"), ("sticky", "sticky")]:
        (root / f"{name}.test.cjs").write_text(
            'const test = require("node:test");\n'
            'const fs = require("node:fs");\n'
            f'test("{name} table header", () => {{\n'
            '  for (let i = 0; i < 1100; i++) console.log("Rendering table preview frame");\n'
            '  const actual = fs.readFileSync("headers.css", "utf8").match(/position: (\\w+)/)[1];\n'
            f'  if (actual !== "{position}") throw Error("Expected {position} header, got " + actual);\n'
            '});\n'
        )
    return root


def commands(bounded):
    if bounded:
        return ["sed -n '1,3p' headers.css", "git diff --stat",
                "node --test passing.test.cjs > passing.log 2>&1; result=$?; tail -14 passing.log; exit $result",
                "node --test sticky.test.cjs > sticky.log 2>&1; result=$?; tail -28 sticky.log; exit $result"]
    return ["cat headers.css", "git diff", "node --test passing.test.cjs", "node --test sticky.test.cjs"]


def prompt(bounded):
    steps = "\n".join(commands(bounded))
    return ("Diagnose the table header regression. Run each of these four foreground shell commands exactly once, "
            "separately, in the given order. Use only the shell in this fixture. The final nonzero exit is expected. "
            "Report the current position and offset, changed filename, passing and failing test names, expected and actual values, "
            "and the last command exit code. Do not edit the fixture.\n" + steps)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--bounded", action="store_true")
    args = parser.parse_args()
    create(args.directory)
    print(prompt(args.bounded))
