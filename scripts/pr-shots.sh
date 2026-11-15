#!/bin/bash
# Puts screenshots where a pull request can show them.
#
#   scripts/pr-shots.sh <pr number> <image>...
#
# A PR description can't show a file that is only on your computer. This adds the images to the pr-screenshots branch
# of origin, under pr-<number>/, and prints one Markdown image line per file to paste into the description. The branch
# shares no history with the code, is never merged, and is created on first use. Your checkout is left as it is.
#
# The images become part of the repository: shoot the browser preview (src/preview), never a real office.
set -euo pipefail

usage() { echo "usage: scripts/pr-shots.sh <pr number> <image>..." >&2; exit 1; }
[ $# -ge 2 ] || usage
pr=$1; shift
case $pr in ''|*[!0-9]*) usage ;; esac
branch=pr-screenshots

# The name a file gets on the branch: its own, with anything a link can't carry (a space, a #) turned into a dash.
name() { basename "$1" | LC_ALL=C tr -c 'A-Za-z0-9._\n-' '-'; }

shopt -s nocasematch
for img in "$@"; do
  [ -f "$img" ] || { echo "no such image: $img" >&2; exit 1; }
  case $img in *.png|*.jpg|*.jpeg|*.gif|*.webp) ;; *) echo "not a png, jpg, gif or webp: $img" >&2; exit 1 ;; esac
done
same=$(for img in "$@"; do name "$img"; done | sort | uniq -d)
[ -z "$same" ] || { echo "two images share a file name, rename one: $same" >&2; exit 1; }

repo=$(git remote get-url origin | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]##; s#\.git$##')

# The commit is built in an index of its own, on top of the branch as it is on origin.
GIT_INDEX_FILE=$(mktemp -u)
export GIT_INDEX_FILE
trap 'rm -f "$GIT_INDEX_FILE"' EXIT

head=
if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
  git fetch -q origin "$branch"
  head=$(git rev-parse FETCH_HEAD)
  git read-tree "$head"
fi
for img in "$@"; do
  git update-index --add --cacheinfo "100644,$(git hash-object -w "$img"),pr-$pr/$(name "$img")"
done
tree=$(git write-tree)
if [ -z "$head" ] || [ "$tree" != "$(git rev-parse "$head^{tree}")" ]; then
  head=$(git commit-tree "$tree" ${head:+-p "$head"} -m "chore: screenshots for #$pr")
  git push -q origin "$head:refs/heads/$branch"
fi

for img in "$@"; do
  file=$(name "$img")
  echo "![${file%.*}](https://github.com/$repo/blob/$head/pr-$pr/$file?raw=true)"
done
