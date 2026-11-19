#!/bin/sh
# Dev mode: restarts the server when server code changes, reloads the browser when public/ changes.
cd "$(dirname "$0")" && DEV=1 exec node --watch server.js
