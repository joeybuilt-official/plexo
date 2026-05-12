# Phase 2 -- Delta Frame Tokens, Assets, Brand System

Generated: 2026-04-25
Direction: Delta Frame (Direction 2 from Phase 1)

---

## What Landed

### Token Migration

The `@theme` block in `apps/web/src/app/globals.css` was rewritten to the Joeybuilt core palette.

**Surface tokens** shifted from near-black (#0C0E14) to Joeybuilt steel (#242936 canvas, #2e3748 surface-1). This gives Plexo visual coherence with the parent brand.

**Accent** changed from azure blue (#3B82F6, hue 217) to Plexo steel-blue (#6db8cc, hue 193). All existing `--color-azure` and `--color-indigo` aliases now resolve through `--color-accent`, so component code using `bg-azure`, `text-azure`, `border-azure` continues to work unchanged.

**Derived scales** (dim, glow, hover) regenerated from the new accent hue. Light mode accent darkened to #3d92a6 for WCAG AA compliance.

**Font stack** updated:
- Display: Syne -> Geist
- Body: Inter -> IBM Plex Sans (Inter as fallback)
- Code: JetBrains Mono (unchanged)

### Token Names Preserved

No component-level class names changed. The following mappings ensure backward compatibility:

| Old class           | Resolves to          |
|---------------------|----------------------|
| `bg-azure`          | `--color-accent`     |
| `text-azure`        | `--color-accent`     |
| `border-azure`      | `--color-accent`     |
| `bg-indigo`         | `--color-accent`     |
| `text-indigo`       | `--color-accent`     |
| All `*-azure-*` variants | Corresponding `--color-accent-*` |

### Hardcoded RGBA Updates

All hardcoded `rgba(59, 130, 246, ...)` (old azure) in globals.css replaced with `rgba(109, 184, 204, ...)` (new accent). Affects:
- `.glow-azure` box-shadow
- `.glow-border` border and hover shadow
- `.bg-grid-dots` radial gradient
- `.hero-glow` radial gradient
- `.light .bg-zinc-800\/80` sidebar override

### SVG Assets

8 SVG files written to `/brand/`:
- Symbol: on-dark, on-light, mono (currentColor)
- Wordmark: on-dark, on-light, lockup (transparent)
- Favicon: 32x32 optimized
- App icon: 512x512 with rounded rect background

### PNG Export

`/brand/export-png.html` renders both PNG targets (512px icon, 1200x630 OG image) via canvas. Open in browser, click download.

---

## Migration Impact

**Zero component changes required.** All color tokens kept their names. The `azure` and `indigo` aliases forward to `accent`. New `--color-accent` token available for new code.

**Font change** (Geist, IBM Plex Sans) requires the actual font files to be loaded -- either via next/font or CDN. Existing font-family CSS vars updated; components using `font-display`, `font-body`, `font-mono` classes resolve automatically.
