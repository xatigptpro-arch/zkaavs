#!/bin/sh
set -eu
Xtigervnc :2 -rfbport 5902 -localhost no -SecurityTypes VncAuth -PasswordFile /profile/vnc.passwd -geometry 1440x900 -depth 24 -AlwaysShared &
vnc_pid=$!
trap 'kill "$vnc_pid" 2>/dev/null || true' EXIT
sleep 2
if [ "${BROWSER_MODE:-controlled}" = manual ] || [ "${BROWSER_MODE:-controlled}" = cdp ]; then
  # This profile belongs only to this container; a prior abrupt stop can leave
  # Chrome's single-instance links behind.
  find /profile/manual -maxdepth 1 -name 'Singleton*' -delete 2>/dev/null || true
  if [ "${BROWSER_MODE:-controlled}" = cdp ]; then
    set -- --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
  else
    set --
  fi
  google-chrome --no-sandbox --disable-dev-shm-usage --user-data-dir=/profile/manual "$@" https://www.canva.com/ &
  browser_pid=$!
  trap 'kill "$browser_pid" "$vnc_pid" 2>/dev/null || true' EXIT
fi
node /app/server.js
