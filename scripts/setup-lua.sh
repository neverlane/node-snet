#!/usr/bin/env bash
# Prepares the Lua SNET reference implementation for interop tests.
# Reference: RazorRw/SNET pinned to a specific commit (the SLMP-Team original is outdated).
set -euo pipefail

SNET_REPO="https://github.com/RazorRw/SNET"
SNET_PIN="19aecbe6c30adea2b005ab71560569ef900f6dfb"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="$ROOT/tests/.cache"
SRC="$CACHE/SNET"

command -v luajit >/dev/null || { echo "luajit not found" >&2; exit 1; }

if [ ! -d "$SRC/.git" ]; then
  mkdir -p "$CACHE"
  git clone --quiet "$SNET_REPO" "$SRC"
fi
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$SNET_PIN" ]; then
  git -C "$SRC" fetch --quiet origin "$SNET_PIN" || git -C "$SRC" fetch --quiet origin
  git -C "$SRC" -c advice.detachedHead=false checkout --quiet "$SNET_PIN"
fi

# Lua code does require("snet.xxx"), so expose SNET/lua as tests/.cache/snet
ln -sfn "SNET/lua" "$CACHE/snet"

# luasocket for LuaJIT (Lua 5.1 ABI)
if ! eval "$(luarocks --lua-version=5.1 path)" 2>/dev/null || ! luajit -e 'require("socket")' 2>/dev/null; then
  luarocks --lua-version=5.1 --local install luasocket
fi

echo "Lua SNET ready: $SRC @ $SNET_PIN"
