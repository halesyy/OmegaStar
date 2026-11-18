#!/usr/bin/env bash
# Runs this checkout (any git worktree) as a test copy of OmegaStar, beside the one you work in and beside other
# test copies, each with its own name, office folder, app id and dev server port.
#
#   scripts/side-by-side.sh [name] [--copy-live]
#
# name         defaults to the current branch. The copy keeps its office in
#              ~/Library/Application Support/OmegaStar-dev-<name> and shows in the Dock as "OmegaStar (<name>)",
#              the name in lower case with dashes.
# --copy-live  starts from a fresh sandbox copy of the release office (scripts/office-copy.sh), replacing this
#              name's earlier copy. Without it, the copy keeps its own office from run to run.
#
# It never opens, changes, quits or updates the release office or the app working in it: a dev build refuses the
# release office, and its own app id keeps the single-instance check, login item and saved window state apart.
set -euo pipefail

die() { echo "side-by-side: $*" >&2; exit 1; }
cd "$(dirname "$0")/.."

name=""
copy_live=0
while [ $# -gt 0 ]; do
  case "$1" in
    --copy-live) copy_live=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$name" ] || die "one name only"; name="$1"; shift ;;
  esac
done
[ -n "$name" ] || name=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo default)
# Letters, digits and dashes only: it goes into an app id and a folder name.
slug=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)
[ -n "$slug" ] || die "the name needs a letter or digit"
[ "$slug" != "release" ] || die "pick another name"

data="$HOME/Library/Application Support/OmegaStar-dev-$slug"
# A port of its own between 1430 and 1929, from the name, so copies started together don't collide. 1420 stays the
# plain `npm run tauri dev` port.
port=$(( 1430 + $(printf '%s' "$slug" | cksum | cut -d' ' -f1) % 250 * 2 ))
config=$(printf '{"identifier":"com.abramindustries.omegastar.dev.%s","productName":"OmegaStar (%s)","build":{"devUrl":"http://localhost:%s"}}' "$slug" "$slug" "$port")

if [ "$copy_live" = 1 ]; then
  scripts/office-copy.sh "$data" --replace
fi
[ -d node_modules ] || npm ci

export OMEGA_CHANNEL=dev
export OMEGASTAR_DATA_DIR="$data"
export OMEGA_DEV_PORT="$port"
echo "Starting OmegaStar ($name) on port $port with its office in $data"
exec npx tauri dev --config "$config"
