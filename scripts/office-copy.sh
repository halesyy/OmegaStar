#!/usr/bin/env bash
# Copies an office into a sandbox you can open with a test build, without changing the office it copies.
#
#   scripts/office-copy.sh <dest> [--from <office>] [--replace]
#
# --from defaults to the release office (~/Library/Application Support/OmegaStar). The source is only read: the
# database through SQLite's read-only backup, everything else with copy-on-write clones where the disk allows
# (APFS), so a copy of a large office is quick and takes almost no space.
#
# The copy is a sandbox (omega.sandbox in its folder): it never starts Claude Code, backs up or watches anyone,
# whichever build opens it. Its schedules are paused and its backups are off, so even a build from before the
# sandbox existed would not write to your backup folder or start your employees' routines.
#
# --replace deletes <dest> first, but only when it is already a sandbox copy.
set -euo pipefail

die() { echo "office-copy: $*" >&2; exit 1; }

src="$HOME/Library/Application Support/OmegaStar"
dest=""
replace=0
while [ $# -gt 0 ]; do
  case "$1" in
    --from) src="${2:?--from needs a folder}"; shift 2 ;;
    --replace) replace=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$dest" ] || die "one destination only"; dest="$1"; shift ;;
  esac
done
[ -n "$dest" ] || die "usage: office-copy.sh <dest> [--from <office>] [--replace]"
command -v sqlite3 >/dev/null || die "needs sqlite3"
[ -f "$src/office.db" ] || die "no office at $src"

# Compare real paths, ignoring case (macOS and Windows file systems usually do).
real() { python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]).lower())' "$1"; }
src_real=$(real "$src")
dest_real=$(real "$dest")
case "$dest_real/" in "$src_real"/*) die "$dest is inside the office it copies" ;; esac
case "$src_real/" in "$dest_real"/*) die "$dest holds the office it copies" ;; esac
live_real=$(real "$HOME/Library/Application Support/OmegaStar")
case "$dest_real/" in "$live_real"/*) die "$dest is the release office" ;; esac

if [ -e "$dest" ]; then
  if [ -n "$(ls -A "$dest" 2>/dev/null)" ]; then
    [ "$replace" = 1 ] || die "$dest is not empty (use --replace to overwrite a sandbox copy)"
    [ -f "$dest/omega.sandbox" ] || die "$dest is not a sandbox copy, so it stays: delete it yourself if you mean to"
    rm -rf "$dest"
  fi
fi
mkdir -p "$dest"

# The database: a consistent snapshot, read-only on the source, so a running Omega Star is never blocked or changed.
sqlite3 "file:$src/office.db?mode=ro" ".backup '$dest/office.db'"

# Everything else but the database and its journals, the log and the running marker. cp -c clones on APFS.
clone() { cp -cR "$1" "$2" 2>/dev/null || cp -R "$1" "$2"; }
for item in "$src"/* "$src"/.[!.]*; do
  [ -e "$item" ] || continue
  name=$(basename "$item")
  case "$name" in
    office.db|office.db-wal|office.db-shm|office.db-journal|omega.log|omega.running|omega.sandbox) continue ;;
  esac
  clone "$item" "$dest/$name"
done

# Belt and braces for builds that predate the sandbox: schedules paused, backups off.
sqlite3 "$dest/office.db" \
  "UPDATE meta SET value = json_set(value, '$.paused', json('true'), '$.backup.frequency', 'off') WHERE key = 'settings';"

printf 'Copied from %s on %s. This office never starts Claude Code, backs up or watches anyone.\n' \
  "$src" "$(date '+%Y-%m-%d %H:%M')" > "$dest/omega.sandbox"

echo "Copied $src to $dest (sandbox: runs, backups and watching are off)."
