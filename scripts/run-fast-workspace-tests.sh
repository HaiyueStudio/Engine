#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
npm_command=${FAST_GATE_NPM_COMMAND:-npm}

cd "$root"
for workspace in $(node scripts/list-fast-gate-workspaces.mjs); do
  printf '\n[fast-gate] testing %s\n' "$workspace"
  "$npm_command" test -w "$workspace"
done
