#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# check-doc-refs.sh — fail when an agent-facing doc cites a repo path that
# exists nowhere in the repo.
#
# Why this exists: AGENTS.md told every agent that `scripts/check-docs.sh` was
# a required-CI landing gate, and pointed four times at `docs/claude/worklog.md`
# as the running worklog. Neither has ever existed. Both survived months of green
# builds because nothing reads the docs. A doc that makes a falsifiable claim
# about the filesystem should be mechanically falsified.
#
# The rule is deliberately loose, because docs legitimately use shorthand: a
# reference passes if the path resolves from the repo root, OR relative to the
# citing document, OR if its basename exists anywhere in the repo. That accepts
# `clean-architecture.md` written as a sibling reference and `store.ts` written
# as shorthand, while still catching a name that exists nowhere. Loose and
# always-on beats strict and switched off.
#
# Usage: sh scripts/check-doc-refs.sh

set -u
cd "$(git rev-parse --show-toplevel)"

INDEX=$(git ls-files | tr '\n' '\n')

DOCS="AGENTS.md CLAUDE.md README.md"
for f in .claude/rules/*.md docs/claude/*.md; do
    [ -e "$f" ] && DOCS="$DOCS $f"
done

missing=0
checked=0

for doc in $DOCS; do
    [ -f "$doc" ] || continue
    docdir=$(dirname "$doc")
    refs=$(grep -o '`[^`]\{3,\}`' "$doc" 2>/dev/null | tr -d '`' || true)
    for ref in $refs; do
        case "$ref" in
            *\**|*\<*|*\>*|*\{*|*\ *|http*|*://*|*'$'*) continue ;;
            scripts/*|packages/*|apps/*|services/*|extensions/*|tests/*|adr/*|docs/*|.github/*|.claude/*|ops/*|docker/*) ;;
            *.md|*.ts|*.tsx|*.sh|*.yml|*.yaml) ;;
            *) continue ;;
        esac
        clean=$(printf '%s' "$ref" | sed 's/:[0-9-]*$//; s/[.,;)]*$//')
        # A doc may legitimately name a path in order to say it is gone.
        # ...and markdown wraps, so look at a small window around the mention.
        if grep -F -B2 -A2 -- "$ref" "$doc" | grep -qiE 'there is no|does not exist|never existed|no such|do not create|was removed|no longer|not in the repo'; then continue; fi
        [ -n "$clean" ] || continue
        checked=$((checked + 1))
        # 1. resolves from repo root, or 2. relative to the citing doc
        [ -e "$clean" ] && continue
        [ -e "$docdir/$clean" ] && continue
        # 3. basename exists somewhere tracked (shorthand reference)
        base=$(basename "$clean")
        if printf '%s\n' "$INDEX" | grep -qx -- ".*/$base" 2>/dev/null; then continue; fi
        if printf '%s\n' "$INDEX" | grep -q -- "/$base\$"; then continue; fi
        if printf '%s\n' "$INDEX" | grep -q -- "^$base\$"; then continue; fi
        echo "MISSING: $doc cites \`$clean\` — no such path, and no \`$base\` anywhere in the repo"
        missing=$((missing + 1))
    done
done

if [ "$missing" -gt 0 ]; then
    echo
    echo "$missing dead path reference(s) in agent-facing docs ($checked checked)."
    echo "Fix the doc, or create the file it promises. An agent will believe it."
    exit 1
fi

echo "✔ no dead path references in agent-facing docs ($checked checked)"
