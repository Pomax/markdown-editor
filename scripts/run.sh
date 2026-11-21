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
dir="$(mktemp -d)" || exit 1
mounted=""
cleanup() {
  if [ -n "$mounted" ]; then
    hdiutil detach -quiet "$dir"
  fi
  rm -rf "$dir"
}
trap cleanup EXIT
if [ "$(uname -s)" = Darwin ]; then
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$dir" "$package" || exit 1
  mounted=1
  apps=("$dir"/*.app)
  app="${apps[0]}"
  executable="$(defaults read "$app/Contents/Info" CFBundleExecutable)" || exit 1
  "$app/Contents/MacOS/$executable" "$@"
else
  dpkg-deb -x "$package" "$dir" || exit 1
  "$dir/usr/bin/markdown-editor" "$@"
fi
