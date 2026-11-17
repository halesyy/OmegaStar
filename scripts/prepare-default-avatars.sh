#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:?Usage: scripts/prepare-default-avatars.sh ORIGINALS_DIRECTORY}
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
destination="$repo_dir/src/assets/avatars"

command -v cwebp >/dev/null || { echo "Install cwebp to prepare avatar assets." >&2; exit 1; }
for group in m f; do
  for index in {1..20}; do
    number=$(printf '%02d' "$index")
    [ -f "$source_dir/$group$number.png" ] || { echo "Missing $source_dir/$group$number.png" >&2; exit 1; }
  done
done

mkdir -p "$destination"
for group in m f; do
  for index in {1..20}; do
    number=$(printf '%02d' "$index")
    cwebp -quiet -resize 256 256 -q 88 -metadata none "$source_dir/$group$number.png" -o "$destination/$group$number.webp"
  done
done

echo "Prepared 40 default avatars in $destination"
