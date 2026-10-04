#!/usr/bin/env python3
"""Homebrew CI curl guard: installer downloads must use the seeded artifact cache."""
import os
import re
import subprocess
import sys

if any(re.search(r"https?://(?:github\.com/pwrdrvr/[^/]+/releases/(?:download|latest/download)/|api\.github\.com/repos/pwrdrvr/[^/]+/releases/assets/)", arg) for arg in sys.argv[1:]):
    sys.exit("Release asset HTTP request blocked in CI. Restore verified build artifact bytes into Homebrew's cache.")
sys.exit(subprocess.call([os.environ.get("CI_REAL_CURL", "/usr/bin/curl"), *sys.argv[1:]]))
