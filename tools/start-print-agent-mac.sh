#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .print-agent.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.print-agent.env
  set +a
fi

: "${HL_PRINT_MODE:=tspl}"
: "${HL_PRINT_PRINTER:=GP-3120TN}"
: "${HL_TSPL_WIDTH_MM:=76}"
: "${HL_TSPL_HEIGHT_MM:=120}"
: "${HL_TSPL_GAP_MM:=0}"
: "${HL_TSPL_COLS:=32}"
: "${HL_PRINT_LP_OPTIONS:=raw}"

if [ -z "${HL_KITCHEN_URL:-}" ] && { [ -z "${HL_PRINT_BASE_URL:-}" ] || { [ -z "${HL_PRINT_TOKEN:-}" ] && [ -z "${HL_KITCHEN_PASSWORD:-}" ]; }; }; then
  echo "Missing HL_KITCHEN_URL, or HL_PRINT_BASE_URL + HL_PRINT_TOKEN, or HL_PRINT_BASE_URL + HL_KITCHEN_PASSWORD." >&2
  echo "Create .print-agent.env from .print-agent.env.example first." >&2
  exit 2
fi

echo "Starting Hawkerline print agent with caffeinate. Close this terminal or press Ctrl-C to stop."
exec caffeinate -dimsu npm run print-agent
