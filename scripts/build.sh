#!/usr/bin/env bash
unset CDPATH
cd "$(dirname "$0")/.." || exit 1
node scripts/build-executable.js
