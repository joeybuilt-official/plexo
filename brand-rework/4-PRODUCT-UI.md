# Phase 4B -- Product UI Pages Restyled

## Summary
All product UI pages restyled to Joeybuilt brand system. Visual-only changes, zero functionality changes.

## Changes Applied

### Border Radius
- `rounded-lg`, `rounded-xl`, `rounded-2xl`, `rounded-3xl`, `rounded-[24px]` -> `rounded-sm` (4px max)
- `rounded-full` on text badges/pills -> `rounded-sm`
- `rounded-full` preserved on: dots, toggles, progress bars, avatars, step indicators

### Shadows
- All `shadow-sm` through `shadow-2xl` removed
- All `shadow-[...]` custom shadows removed
- All `shadow-inner` removed
- `drop-shadow-[...]` removed
- Toggle knob shadows (functional) preserved

### Gradients
- All `bg-gradient-*` replaced with flat solid equivalents (e.g. `bg-azure/10`)
- `text-transparent bg-clip-text bg-gradient-*` text gradients replaced with `text-text-primary`
- Orphaned `from-*` / `to-*` classes cleaned up

### Blur
- All `backdrop-blur-*` removed

### Font Weights
- `font-bold` -> `font-medium` (500 max for headings)
- `font-semibold` -> `font-medium`
- `font-extrabold` -> `font-medium`

### Status Badges
- `StatusBadge` component (packages/ui) updated to `[BRACKET]` stamp pattern with `font-mono uppercase tracking-wider`
- Federation local `StatusBadge` updated to bracket stamp
- Agent status indicator updated to `[RUNNING]` / `[IDLE]` bracket pattern

### Loading States
- `apps/web/src/app/app/loading.tsx` -> blinking `_` cursor with "Loading" text
- `apps/web/src/app/app/chat/loading.tsx` -> blinking `_` cursor with "Loading chat" text
- CSS circular spinners (border-based) replaced with blinking cursor motif
- Icon-based spinners (Loader2, RefreshCw) on buttons preserved (functional feedback)

### Chat/Conversations
- Timestamp display set to `font-mono`
- Message bubble hover lift (`hover:-translate-y-0.5`) removed
- Image hover scale (`hover:scale-[1.02]`) removed

### Other
- Scale transforms on hover removed
- All `text-shadow-glow` removed

## Pages Covered
1. Dashboard/Home (`_components/`)
2. Tasks
3. Chat/Conversations
4. Memory/SCL
5. Settings (all sub-pages: federation, context, privacy, voice, search, channels, intelligence, users)
6. Works
7. Projects
8. Approvals/Escalations
9. Extensions/Hub
10. Debug/Ops
11. Error/Loading states
12. Agents
13. Conversations
14. Logs
15. Account
16. Workbench
17. Intelligence wizard

## Verification
- `tsc --noEmit` passes (web + ui packages)
- No functional changes
