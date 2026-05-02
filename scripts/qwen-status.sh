#!/usr/bin/env bash
set -euo pipefail
URL="${1:-http://localhost:3737/api/qwen-status}"
if command -v curl >/dev/null 2>&1; then
  curl -sS "$URL" | (command -v jq >/dev/null 2>&1 && jq . || cat)
else
  echo "curl is required to query $URL" >&2
  exit 1
fi
