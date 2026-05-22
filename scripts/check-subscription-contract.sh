#!/usr/bin/env bash
# Phase 4 slice 4e (#111) — fail CI if any forbidden subscription pattern
# survives in preload or renderer source. After slice 4a, every broadcast
# subscription on `window.api` returns an `Unsubscribe` disposer; there are
# no `off*` methods and no `ipcRenderer.removeAllListeners(…)` calls.
#
# Regex requires the open paren so the contract-doc comment in
# `src/preload/subscribe.ts` (which mentions the names without calling them)
# stays allowed.

set -euo pipefail

PATTERN='removeAllListeners\(|window\.api\.off[A-Z][A-Za-z0-9_]*\('

# Use --include to be explicit about file types; --exclude-dir to skip build
# outputs that grep would otherwise scan if invoked at the repo root.
MATCHES="$(grep -rEn \
  --include='*.ts' --include='*.vue' --include='*.tsx' --include='*.js' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=out \
  "$PATTERN" \
  src/preload/ src/renderer/ \
  || true)"

if [ -n "$MATCHES" ]; then
  echo "Subscription-contract violation — forbidden patterns survived:"
  echo
  echo "$MATCHES"
  echo
  echo "After #111 slice 4a, every broadcast subscription on \`window.api\`"
  echo "returns an \`Unsubscribe\` disposer. \`removeAllListeners()\` and"
  echo "\`window.api.off*()\` are not part of the contract. Capture the"
  echo "returned disposer and call it in \`onBeforeUnmount\`/\`onUnmounted\`"
  echo "(or in a Pinia store's setup, for lifetime-scoped subscriptions)."
  exit 1
fi
