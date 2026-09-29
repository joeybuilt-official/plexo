# Plan: <feature name>

- **Area:** `<area>`  ·  **Started:** YYYY-MM-DD  ·  **Status:** In progress
- **Owner:** <who is driving this>
- **Next step:** the exact next action to resume this cold — the file to open, the function to change, the command to run, the blocker. Refresh it every time you stop.
- **Roadmap initiative:** the `../../roadmap.md` initiative this plan executes _(delete if this is a standalone one-off with no strategic home — but prefer to name one)_.
- **Parent plan:** _(link if this is a sub-milestone; otherwise delete)_

## Goal

One paragraph. What is true after this ships that is not true now, stated in terms of what a user or
caller can do. Include how we will know it worked.

**Out of scope:** what this deliberately does not do. Naming this prevents scope creep mid-build.

## Context

What a fresh session needs to know to pick this up cold: the current behavior, the files and modules
involved, relevant decisions already made (link the ADR in `../../architecture.md`), and any
constraint that rules out the obvious approach.

## Architecture

Fill this before the first milestone — a plan that cannot name its layers is not ready to build.
Write "none" where a row genuinely does not apply; delete no row.

- **Layers touched:** which of Entities/Domain · Use Cases/Application · Interface Adapters ·
  Frameworks & Drivers this change adds to or modifies.
- **New ports (interfaces):** name each, the use-case layer it is declared in, and the adapter that
  implements it — or "none".
- **Boundary data:** the DTOs crossing each boundary. Confirm no domain entity is serialized to the
  wire or handed to an ORM by reflection.
- **Dependency direction:** confirm every new dependency points inward. If any points outward, stop —
  raise it in Open questions and get a decision before building.
- **Swap test:** name the vendor/framework this touches; the diff to replace it must stay inside
  Interface Adapters + Frameworks & Drivers.

## Milestones

Each milestone is independently reviewable and leaves the system working. Re-read this section at
the start of each one.

- [ ] **M1 — <name>** — <what changes, which files>
- [ ] **M2 — <name>** — <what changes, which files>
- [ ] **M3 — tests, docs, and cleanup of anything the change orphaned**

## Open questions

Decisions needed from a human before this can proceed. A plan that starts with an open question in
this list is blocked, not ready.

## Verification

How each milestone is proven done: the exact command, and what its output must show.

## Worklog

The `CHANGELOG.md` `[Unreleased]` entry lands in the **same commit** as the work it describes.
