# Spec: Task & Project Finesse Overhaul

## Why
Current Task and Project interfaces are functional but lack consistency and premium polish. Code-heavy "Control Room" layouts feel cramped for non-technical tasks, and fragmented status configurations make UI maintenance difficult.

## How

### 1. Centralized Design System (`packages/ui`)
- Create a shared `StatusBadge` and `CategoryBadge` in `packages/ui` that consumes a unified config.
- Eliminate hardcoded color/icon maps in `apps/web`.

### 2. Project List & Detail Optimizations
- **List View**: Add "Quick Summary" snippets to cards. Show "Last Deliverable" link.
- **Control Room**: Implement "Category-Aware" Tab priority.
    - Research/Writing -> Deliverables tab is default.
    - Code/Ops -> Workers/Logs tab is default.
- **Micro-animations**: Pulse effects for active runs, slide-ins for log entries.

### 3. Task List Refinement
- High-density table layout with better grouping.
- "Action" hover state for immediate Cancel/Retry/Delete without opening details.
- Clearer "Source" attribution (Chat vs API vs Scheduled).

### 4. Visual Excellence Pass
- Standardize on `zinc-900`/`surface-1` glassmorphism.
- Use `azure` (primary), `amber` (warning), and `red` (error) accent tokens consistently.
- Implement smooth transitions between list and detail views.

## Risks
- **Data Density**: Adding too much "finesse" (animations/gradients) could slow down the UI on low-powered machines.
- **Regression**: Changing shared badge logic might break filters if status strings are mapped incorrectly.

## Verification
- **Visual**: Side-by-side comparison of old vs new components.
- **E2E**: Verify filtering functionality stays intact after centralizing labels.
- **Performance**: Monitor DOM node count on high-volume task lists.
