#!/usr/bin/env sh
set -eu

message="${1:-hello}"

if [ -n "${TMUX:-}" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT HUP INT TERM

  printf '%s\n' "$message" > "$tmp"
  tmux display-popup -E "cat '$tmp'; printf '\nPress Enter to close...'; read _"
else
  printf '%s\n' "$message"
fi
