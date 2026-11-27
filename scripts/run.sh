#!/usr/bin/env bash
unset CDPATH
root="$(cd "$(dirname "$0")/.." && pwd -P)"
if [ "$(uname -s)" = Darwin ]; then
  package="$root/dist/macos/Markdown-Editor.dmg"
else
  package="$root/dist/ubuntu/Markdown-Editor.deb"
fi
if [ ! -f "$package" ]; then
  echo "No release build at $package: run scripts/build.sh first" >&2
  exit 1
fi
if [ "$(uname -s)" = Darwin ]; then
  for leftover in "${TMPDIR:-/tmp}"/markdown-editor-run.*; do
    [ -d "$leftover" ] || continue
    hdiutil detach -quiet "$leftover"
    rmdir "$leftover" 2>/dev/null
  done
fi
dir="$(mktemp -d "${TMPDIR:-/tmp}/markdown-editor-run.XXXXXX")" || exit 1
mounted=""
running=""
cleanup() {
  if [ -n "$running" ]; then
    kill "$running" 2>/dev/null
    wait "$running"
  fi
  if [ -n "$mounted" ]; then
    hdiutil detach -quiet "$dir"
  fi
  rm -rf "$dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$(uname -s)" = Darwin ]; then
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$dir" "$package" || exit 1
  mounted=1
  apps=("$dir"/*.app)
  app="${apps[0]}"
  executable="$(defaults read "$app/Contents/Info" CFBundleExecutable)" || exit 1
  "$app/Contents/MacOS/$executable" "$@" &
else
  dpkg-deb -x "$package" "$dir" || exit 1
  "$dir/usr/bin/markdown-editor" "$@" &
fi
running=$!
wait "$running"
status=$?
running=""
exit "$status"
