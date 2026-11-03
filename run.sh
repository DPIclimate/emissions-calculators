#!/bin/sh
set -e

# Run the calculator directory watcher.
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  printf '%s\n' 'Usage: ./run.sh [-h|--help]' 'Run the calculator directory watcher.' 'Uses Apple container on macOS and Docker on Linux.'
  exit 0
fi

case "$(uname -s)" in
  Darwin) container_command=container ;;
  Linux) container_command=docker ;;
  *) printf '%s\n' 'Unsupported operating system: use macOS or Linux.' >&2; exit 1 ;;
esac

mkdir -p inputs/cotton inputs/grains outputs done

"$container_command" run --rm \
  --name eap-calculators \
  --cpus 2 \
  --memory 2G \
  --volume "$PWD/inputs:/inputs" \
  --volume "$PWD/outputs:/outputs" \
  --volume "$PWD/done:/done" \
  eap-calculators:4.0.2 \
  --watch --workers 2 --timezone Australia/Sydney
