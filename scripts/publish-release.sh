#!/usr/bin/env bash
# Copies a finished release from this private repo to the public one installs update from
# (itsfutsy/omegastar-releases): a private repo's downloads need a login, which the updater does not have.
# Run it once the Release workflow for the tag has published. Needs `gh` signed in with access to both.
set -euo pipefail

tag=${1:?usage: scripts/publish-release.sh v0.4.1}
src=itsfutsy/Omegastar
dst=itsfutsy/omegastar-releases
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

gh release download "$tag" --repo "$src" --dir "$dir"
# The updater manifest links each platform to a private asset by id; link it to the public copy by name.
names=$(gh api "repos/$src/releases/tags/$tag" --jq '[.assets[] | {key: (.id | tostring), value: .name}] | from_entries')
jq --argjson names "$names" --arg base "https://github.com/$dst/releases/download/$tag/" \
  '.platforms |= map_values(.url |= $base + $names[(split("/") | last)])' "$dir/latest.json" > "$dir/latest.json.new"
mv "$dir/latest.json.new" "$dir/latest.json"
if jq -e '.platforms[].url | select(test("/releases/download/") | not)' "$dir/latest.json" >/dev/null; then
  echo "latest.json still has a link the rewrite missed" >&2
  exit 1
fi

gh release create "$tag" --repo "$dst" --title "Omega Star $tag" --notes "$(gh release view "$tag" --repo "$src" --json body -q .body)" "$dir"/*
echo "Published $tag to https://github.com/$dst/releases/tag/$tag"
