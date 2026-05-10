# Phase 3 -- Geometric Precision Tokens, Assets, Brand System

Generated: 2026-04-24
Direction: Tesseract Frame (Candidate 2 from Phase 2)

---

## What Changed

### Surface Palette

V1 steel-blue surfaces replaced with navy-black mathematical canvas.

| Token | V1 | V2 | Delta |
|-------|----|----|-------|
| `canvas` | `#242936` | `#101520` | Much darker. Navy-black vs steel-gray. |
| `surface-1` | `#2e3748` | `#161D2C` | Deeper blueprint tone. |
| `surface-2` | `#364258` | `#1D2640` | Blue-shifted. Deliberate hue. |
| `surface-3` | `#3d4a5c` | `#243052` | More saturation in focused states. |
| `border` | `#3d4a5c` | `#253354` | Construction-line blue vs neutral gray. |
| `border-subtle` | `#333e50` | `#1C2744` | Lower contrast, grid-line feel. |

### Text

| Token | V1 | V2 |
|-------|----|----|
| `text-primary` | `#e8edf2` | `#E2E8F0` |
| `text-secondary` | `#8a9ab0` | `#8294B0` |
| `text-muted` | `#6b7a92` | `#576A88` |

Slightly cooler. Primary virtually identical. Secondary/muted shifted to blueprint annotation tone.

### Accent

| Token | V1 | V2 |
|-------|----|----|
| `accent` | `#6db8cc` (hue 193, low sat) | `#4DAAFC` (hue 213, high sat) |
| `accent-dim` | `#5aa3b8` | `#3B8FDE` |
| `accent-hover` | `#82c6d6` | `#6DBCFF` |

Major shift. V1 was desaturated teal. V2 is high-saturation electric blue. Reads as precision instrument, not friendly dashboard.

### Signal Colors

| Token | V1 | V2 |
|-------|----|----|
| `red` | `#EF4444` (red-500) | `#F43F5E` (rose-500) |
| `amber` | `#F59E0B` | `#F59E0B` (unchanged) |
| `green` | (none) | `#10B981` (new: signal-green) |

Rose reads more urgent against blue ground. Green added as explicit signal token.

### Light Mode

Light accent: `#3d92a6` -> `#2B7DC0`. Darker blue for AA contrast on white.

### Symbol

Delta Frame (open triangle + 3 dots) replaced with Tesseract Frame (outer square + inner 45deg square + projection lines + center node). The tesseract encodes SCL's core operation: projecting high-dimensional semantic space into navigable structure.

Favicon simplified: heavier strokes, no projection lines, readable at 16px.

### SVG Assets

All 8 SVG files in `/brand/` rewritten with tesseract geometry. `export-png.html` updated to render V2 tesseract for PNG export.

### PlexoMark Component

`apps/web/src/components/plexo-logo.tsx` rewritten:
- Geometry: tesseract frame replaces delta frame
- Idle state: projection-line shimmer (2.4s cycle)
- Working state: inner square rotates (8s/revolution)
- Wordmark tracking tightened to -0.03em per type spec

---

## Migration Impact

**Zero component changes required.** All color token names preserved. Azure/indigo aliases still resolve through accent. Font vars unchanged.

**Visual impact is significant.** Canvas is much darker, accent is more saturated, symbol is geometrically different. Every screen will look noticeably different. This is intentional -- V2 is a distinct visual identity.
