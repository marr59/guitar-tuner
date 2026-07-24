#!/usr/bin/env bash
# tools/nightly-research.sh — тонкая обёртка, логика в nightly_research.py
set -euo pipefail
cd "$(dirname "$0")/.."
LOG="${1:-/var/log/tuning-research.log}"
exec python3 tools/nightly_research.py 2>&1 | tee -a "$LOG"
