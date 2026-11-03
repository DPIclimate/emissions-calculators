#!/bin/sh
set -e

# Run the calculator web server on localhost:8080.
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  printf '%s\n' 'Usage: ./server.sh [-h|--help]' 'Run the calculator web server on localhost:8080.' 'Uses Apple container on macOS and Docker on Linux.'
  exit 0
fi

case "$(uname -s)" in
  Darwin) container_command=container ;;
  Linux) container_command=docker ;;
  *) printf '%s\n' 'Unsupported operating system: use macOS or Linux.' >&2; exit 1 ;;
esac

"$container_command" run --rm \
  --name eap-calculators-web \
  --cpus 2 --memory 2G \
  --publish 127.0.0.1:8080:8080 \
  --entrypoint node \
  eap-calculators:4.0.2 /app/server.mjs
