#!/usr/bin/env bash
unset CDPATH
root="$(cd "$(dirname "$0")/.." && pwd -P)"
args=()
for arg in "$@"; do
  if [ "${arg#-}" = "$arg" ]; then
    if [ -d "$arg" ]; then
      arg="$(cd "$arg" && pwd -P)"
    elif [ -d "$(dirname "$arg")" ]; then
      arg="$(cd "$(dirname "$arg")" && pwd -P)/$(basename "$arg")"
    fi
    arg="${arg#"$root"/}"
  fi
  args+=("$arg")
done
cd "$root" || exit 1
if [ ${#args[@]} -eq 0 ]; then
  npm test
elif [[ "${args[0]}" == *.test.js ]]; then
  node --test "${args[@]}"
else
  npm run test:integration -- "${args[@]}"
fi
