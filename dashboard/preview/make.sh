#!/bin/sh
# Regenerate dashboard/preview.png, the clickable image at the top of the
# README. Serves the repository locally, captures the dashboard's panels in
# headless Chrome and arranges them. Needs python3 with Pillow, Node 22+ and
# google-chrome. Run from anywhere; takes about 15 seconds.
set -e
cd "$(dirname "$0")/../.."
work=$(mktemp -d)
trap 'kill $server 2>/dev/null; rm -rf "$work"' EXIT
python3 -m http.server 8799 --bind 127.0.0.1 >/dev/null 2>&1 &
server=$!
sleep 1
node dashboard/preview/capture.mjs "http://127.0.0.1:8799/dashboard/" "$work" "$work/profile"
python3 dashboard/preview/compose.py "$work" dashboard/preview.png
