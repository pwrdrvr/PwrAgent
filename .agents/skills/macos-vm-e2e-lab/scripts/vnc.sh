#!/usr/bin/env bash
# Open a durable Screen Sharing session to a PwrAgent lab VM. This is opt-in:
# regular VM E2E runs do not open or focus a host-side window.

set -euo pipefail

VM=${1:-pwragent-dev}
IP=$(tart ip "$VM")
exec open "vnc://admin:admin@$IP"
