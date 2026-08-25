#!/bin/bash
# One-off script: regenerate real per-release changelogs for every existing
# GitHub Release, replacing the old static boilerplate every release used to
# carry verbatim. Not part of any workflow -- .github/workflows/desktop-release.yaml
# generates real changelogs going forward on its own; this just backfills the
# releases that were cut before that existed. Safe to re-run (idempotent,
# only ever overwrites --notes on releases that already exist).
set -euo pipefail

REPO="WentTheFox/VRCX-Headless"
PLATFORM_NOTES="Desktop client (Electron) build for %s. Self-signed installers for Windows (x64/arm64), unsigned images for Linux (x64/arm64) and macOS (Apple Silicon only) -- see CLAUDE.md's \"Desktop client OS support\" table for what's actually verified per platform. Windows builds require a system-wide .NET 10 runtime install. macOS builds are unsigned -- Gatekeeper will show an 'unidentified developer' warning on first launch."

for tag in $(gh release list -R "$REPO" --limit=200 --json tagName --jq '.[].tagName' | sort -V); do
    major="${tag%%.*}"

    mapfile -t tags < <(git tag -l "${major}.*.0" --sort=v:refname)
    prev_tag=""
    for i in "${!tags[@]}"; do
        if [ "${tags[$i]}" = "$tag" ]; then
            [ "$i" -gt 0 ] && prev_tag="${tags[$((i - 1))]}"
            break
        fi
    done

    if [ -n "$prev_tag" ]; then
        range="${prev_tag}..${tag}"
    else
        range="$(git rev-list --max-parents=0 HEAD)..${tag}"
    fi

    notes_file="$(mktemp)"
    {
        echo "## Changes"
        echo
        commits="$(git log "$range" --no-merges --pretty=format:'- %s (%h)')"
        if [ -n "$commits" ]; then
            echo "$commits"
        else
            echo "_No commits in this range (tag history predates the changelog range, or this range is empty)._"
        fi
        echo
        echo "## Platform notes"
        echo
        # shellcheck disable=SC2059
        printf "$PLATFORM_NOTES" "$tag"
        echo
    } > "$notes_file"

    echo "=== $tag (prev: ${prev_tag:-none}) ==="
    cat "$notes_file"
    echo

    if [ "${DRY_RUN:-}" != "1" ]; then
        gh release edit "$tag" -R "$REPO" --notes-file "$notes_file"
    fi
    rm -f "$notes_file"
done
