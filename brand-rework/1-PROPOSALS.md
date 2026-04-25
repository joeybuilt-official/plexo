# Phase 1 -- Identity Proposals

Generated: 2026-04-25
Input: Phase 0 Audit
Panel: Castellan (symbol), Berg (product UI), Ranganathan (tokens), Qasimi (semiotics), Okafor (UX), Rams-Ive proxy (reduction)

---

## Direction 1: Bracket Triad

### Concept

Three dots in a downward-pointing triangle formation, flanked by open square brackets. The brackets are the Joeybuilt `[ ]` motif rendered as two L-shaped strokes framing the triad. This direction says "Plexo is the thing inside Joeybuilt's container" -- the dots are agents, the brackets are the platform boundary. It preserves the 3-node heritage literally while adding the parent-brand framing device. The result is structural, typographic, and immediately parseable as a favicon.

### Symbol SVG (48x48)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <path d="M10 12 L6 12 L6 36 L10 36" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M38 12 L42 12 L42 36 L38 36" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="24" cy="14" r="3.5" fill="#7bbfd4"/>
  <circle cx="16" cy="32" r="3.5" fill="#7bbfd4"/>
  <circle cx="32" cy="32" r="3.5" fill="#7bbfd4"/>
</svg>
```

### Favicon SVG (32x32)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <path d="M6 8 L3 8 L3 24 L6 24" stroke="#7bbfd4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M26 8 L29 8 L29 24 L26 24" stroke="#7bbfd4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="16" cy="10" r="2.5" fill="#7bbfd4"/>
  <circle cx="10.5" cy="22" r="2.5" fill="#7bbfd4"/>
  <circle cx="21.5" cy="22" r="2.5" fill="#7bbfd4"/>
</svg>
```

### Wordmark Lockup

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 48" fill="none">
  <path d="M10 12 L6 12 L6 36 L10 36" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <path d="M38 12 L42 12 L42 36 L38 36" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="24" cy="14" r="3.5" fill="#7bbfd4"/>
  <circle cx="16" cy="32" r="3.5" fill="#7bbfd4"/>
  <circle cx="32" cy="32" r="3.5" fill="#7bbfd4"/>
  <text x="54" y="33" font-family="'Geist', 'Inter', system-ui, sans-serif" font-weight="600" font-size="22" fill="#e8edf2" letter-spacing="-0.02em">plexo</text>
</svg>
```

### Proposed Accent

`#7bbfd4` -- No shift. Plexo owns the parent accent directly. Delta-E = 0.

### Panel Comments

**Mira Castellan (Symbol):** "The brackets give this mark a container metaphor that none of the competitors have. At 16px the brackets still read as framing strokes and the dots hold. My concern is whether the horizontal spread gets too wide for square aspect ratios."

**Jonas Berg (Product UI):** "In the sidebar at 20px this will look native -- it reads like a code token. The bracket strokes need to be thicker at small sizes or they vanish on low-DPI displays."

**Priya Ranganathan (Tokens):** "Zero accent delta means zero token migration for the primary color. Every `--color-azure` just becomes `--color-accent` mapped to `#7bbfd4`. Simplest path."

**Dr. Arif Qasimi (Semiotics):** "Brackets universally signify containment, encapsulation, and structured thought -- exactly right for a platform that wraps AI agents. The triad-inside-container reads as 'organized intelligence' across cultures."

**Lena Okafor (UX):** "Users scanning a tab bar will distinguish this from generic circle marks because of the bracket strokes. Good discriminability. But it may feel more 'developer tool' than 'AI platform' to non-technical users."

**Rams-Ive proxy:** PASS. Five primitives (2 paths, 3 circles). Nothing to remove.

### Tradeoffs

- (+) Strongest parent-brand connection (literal `[ ]` reference)
- (+) Zero accent migration effort
- (+) Reads as code/platform at a glance
- (-) Wider aspect ratio than a circle -- may need padding in square containers
- (-) Bracket strokes thin at 16px on 1x displays
- (-) Leans "developer" -- could narrow perceived audience

---

## Direction 2: Delta Frame

### Concept

An open triangle (delta) formed by three strokes, with three dots at the vertices. The bottom edge has a centered gap, creating a subtle underscore/ground-line reference. This direction evolves the original PlexoMark's connecting-lines topology -- instead of lines between nodes, the nodes ARE the vertices of a geometric frame. The gap in the base reads as an opening, a port, an entry point. It is the most architecturally assertive of the three directions.

### Symbol SVG (48x48)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <line x1="24" y1="10" x2="12" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="24" y1="10" x2="36" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="34" x2="20" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="28" y1="34" x2="36" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <circle cx="24" cy="10" r="3" fill="#6db8cc"/>
  <circle cx="12" cy="34" r="3" fill="#6db8cc"/>
  <circle cx="36" cy="34" r="3" fill="#6db8cc"/>
</svg>
```

### Favicon SVG (32x32)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <line x1="16" y1="6" x2="7" y2="24" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="6" x2="25" y2="24" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="7" y1="24" x2="13" y2="24" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="19" y1="24" x2="25" y2="24" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <circle cx="16" cy="6" r="2.5" fill="#6db8cc"/>
  <circle cx="7" cy="24" r="2.5" fill="#6db8cc"/>
  <circle cx="25" cy="24" r="2.5" fill="#6db8cc"/>
</svg>
```

### Wordmark Lockup

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 48" fill="none">
  <line x1="24" y1="10" x2="12" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="24" y1="10" x2="36" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="34" x2="20" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <line x1="28" y1="34" x2="36" y2="34" stroke="#6db8cc" stroke-width="2" stroke-linecap="round"/>
  <circle cx="24" cy="10" r="3" fill="#6db8cc"/>
  <circle cx="12" cy="34" r="3" fill="#6db8cc"/>
  <circle cx="36" cy="34" r="3" fill="#6db8cc"/>
  <text x="54" y="33" font-family="'Geist', 'Inter', system-ui, sans-serif" font-weight="600" font-size="22" fill="#e8edf2" letter-spacing="-0.02em">plexo</text>
</svg>
```

### Proposed Accent

`#6db8cc` -- Slightly darker/more saturated than parent. Delta-E ~8 from `#7bbfd4`. Gives Plexo its own register within the steel-blue family without breaking coherence.

### Panel Comments

**Mira Castellan (Symbol):** "The gap in the base is the strongest single design move in any of these directions. It turns a static triangle into something with a threshold. At 16px the gap still reads because the dots anchor it. Seven SVG elements is fine."

**Jonas Berg (Product UI):** "This mark has inherent directionality -- it points up. In a sidebar it will naturally draw the eye. The slight accent shift from parent gives Plexo enough room to feel like its own product in multi-app contexts."

**Priya Ranganathan (Tokens):** "The `#6db8cc` accent requires a new token value but stays in the same HSL neighborhood (hsl(193, 48%, 61%) vs parent hsl(193, 50%, 66%)). All derived scales (hover, muted, ring) can be auto-generated from the same hue."

**Dr. Arif Qasimi (Semiotics):** "The delta/triangle is historically the symbol of change and transformation. The open base avoids the closed-system reading of a sealed triangle -- it suggests an open platform. The upward orientation implies aspiration without being aggressive."

**Lena Okafor (UX):** "Strongest favicon of the three. The triangular silhouette is immediately distinguishable from circular or square marks in a browser tab bar. The gap prevents it from being confused with a play button or warning icon."

**Rams-Ive proxy:** PASS. Seven primitives (4 lines, 3 circles), but each serves a purpose. The gap is the only decorative move and it carries meaning.

### Tradeoffs

- (+) Most distinctive silhouette -- instant tab recognition
- (+) Closest evolution of original 3-node triangle topology
- (+) The gap is a genuinely novel detail that carries meaning
- (+) Own accent within family gives Plexo product identity
- (-) Slight accent shift means token migration is not zero-effort
- (-) Upward-pointing triangle could read as "warning" in some UI contexts if miscolored
- (-) Most complex of the three (7 elements vs 5)

---

## Direction 3: Stacked Nodes

### Concept

Three dots in a vertical column, sitting above an underscore bar. Maximum reduction. The vertical arrangement reads as a stack, a queue, a pipeline -- agents lined up and ready. The underscore is Joeybuilt's `_` ground-line motif rendered literally. This direction abandons the triangle topology entirely in favor of pure verticality. It is the most abstract, the most minimal, and the most dependent on the wordmark to carry brand recognition.

### Symbol SVG (48x48)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none">
  <circle cx="24" cy="12" r="3.5" fill="#7bbfd4"/>
  <circle cx="24" cy="24" r="3.5" fill="#7bbfd4"/>
  <circle cx="24" cy="36" r="3.5" fill="#7bbfd4"/>
  <line x1="14" y1="43" x2="34" y2="43" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round"/>
</svg>
```

### Favicon SVG (32x32)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <circle cx="16" cy="7" r="2.5" fill="#7bbfd4"/>
  <circle cx="16" cy="15.5" r="2.5" fill="#7bbfd4"/>
  <circle cx="16" cy="24" r="2.5" fill="#7bbfd4"/>
  <line x1="9" y1="29" x2="23" y2="29" stroke="#7bbfd4" stroke-width="2" stroke-linecap="round"/>
</svg>
```

### Wordmark Lockup

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 48" fill="none">
  <circle cx="18" cy="12" r="3.5" fill="#7bbfd4"/>
  <circle cx="18" cy="24" r="3.5" fill="#7bbfd4"/>
  <circle cx="18" cy="36" r="3.5" fill="#7bbfd4"/>
  <line x1="8" y1="43" x2="28" y2="43" stroke="#7bbfd4" stroke-width="2.5" stroke-linecap="round"/>
  <text x="42" y="33" font-family="'Geist', 'Inter', system-ui, sans-serif" font-weight="600" font-size="22" fill="#e8edf2" letter-spacing="-0.02em">plexo</text>
</svg>
```

### Proposed Accent

`#7bbfd4` -- No shift. Same reasoning as Direction 1. Plexo owns the parent accent.

### Panel Comments

**Mira Castellan (Symbol):** "Four primitives. This is the endgame of reduction. At 16px it reads cleanly because everything is centered on one axis. The risk is that three vertical dots are a universal 'more menu' icon -- kebab collision."

**Jonas Berg (Product UI):** "I like the vertical rhythm and how it pairs with the wordmark. But Mira is right about the kebab problem. Every browser, every mobile OS uses three vertical dots for overflow menus. We would need the underscore bar to do heavy lifting to disambiguate."

**Priya Ranganathan (Tokens):** "Same zero-delta accent as Direction 1. Token-wise, identical effort. The symbol itself has no color complexity -- single fill, single stroke."

**Dr. Arif Qasimi (Semiotics):** "Vertical stacking reads as hierarchy, sequence, and process. The underscore grounds it -- 'these agents are on a foundation.' Cross-culturally this is neutral and clean. The kebab association is a real concern in digital contexts but less so in print or physical applications."

**Lena Okafor (UX):** "In a browser tab at 16px, three dots and a line is going to be hard to distinguish from other minimal marks. This direction needs the wordmark present to work. As a standalone favicon it is the weakest of the three."

**Rams-Ive proxy:** PASS, but with a note. "Four elements is excellent economy. The kebab collision is a functional problem, not an aesthetic one. If the underscore bar is thick enough to read as a deliberate platform element rather than an underline, it survives."

### Tradeoffs

- (+) Maximum reduction -- 4 primitives total
- (+) Cleanest vertical lockup with wordmark
- (+) Zero accent migration effort
- (+) Underscore motif is the most literal Joeybuilt reference
- (-) Kebab menu collision is a real disambiguation risk
- (-) Weakest standalone favicon -- needs wordmark to carry recognition
- (-) Abandons triangle topology entirely -- heritage connection is "3 dots" only
- (-) Tall aspect ratio awkward in horizontal layouts

---

## Comparison Matrix

| Criterion | Dir 1: Bracket Triad | Dir 2: Delta Frame | Dir 3: Stacked Nodes |
|-----------|---------------------|-------------------|---------------------|
| Accent hex | `#7bbfd4` | `#6db8cc` | `#7bbfd4` |
| Delta-E from parent | 0 | ~8 | 0 |
| SVG elements | 5 | 7 | 4 |
| Heritage preserved | 3 dots + bracket framing | 3 dots + triangle lines + gap | 3 dots + underscore |
| Joeybuilt rhyme | `[ ]` brackets | `_` underscore (gap) | `_` underscore (bar) |
| Favicon strength | Good | Best | Weakest |
| Aspect ratio | Wide | Equilateral | Tall |
| Rams-Ive | PASS | PASS | PASS (with note) |
| Migration effort | Lowest | Low | Lowest |
| Collision risk | None | Warning icon (if miscolored) | Kebab menu |

---

## Next Step

Pick one direction (or a hybrid). Phase 2 will build the full token system, component library updates, and migration plan from that selection.
