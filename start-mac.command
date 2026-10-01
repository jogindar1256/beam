#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  # Finder-launched shells may miss Homebrew/nvm paths; try the usual places.
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.nvm/versions/node"/*/bin; do [ -x "$p/node" ] && PATH="$p:$PATH" && break; done
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 18.15 or newer is required: https://nodejs.org"; echo "Press Enter to close."; read -r _; exit 1; }
node src/main.js
