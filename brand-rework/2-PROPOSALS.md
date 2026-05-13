# Plexo Rebrand V2 -- Phase 2 Proposals

**Date:** 2026-04-24
**Depends on:** 1-PERSONALITY.md

---

## Candidate 1: TERMINAL SUBSTRATE

**Angle:** Plexo as live runtime. The brand looks like a system you SSH into, not a product you sign up for. Green-on-dark terminal heritage pushed into a modern control plane.

### Surface Palette

| Token | Hex | Reasoning |
|-------|-----|-----------|
| `canvas` | `#0C1117` | Near-black with cold blue bias. Terminal void. |
| `surface-1` | `#131B25` | Cards carved from canvas, not floating above. |
| `surface-2` | `#1A2533` | Active panels, selected rows. |
| `surface-3` | `#223040` | Hover/pressed. Enough step to register. |
| `border` | `#1E2A38` | Low contrast -- borders define, not decorate. |
| `border-subtle` | `#162230` | Near-invisible structural lines. |
| `text-primary` | `#D4E0ED` | Cool white. Reads clean at 13px. |
| `text-secondary` | `#7B8FA6` | Dimmed but not gray -- retains blue. |
| `text-muted` | `#4E6378` | Disabled, timestamps. |

### Accent System

| Token | Hex | Use |
|-------|-----|-----|
| `accent` | `#00E5A0` | Primary actions, live indicators, active agents. Electric green -- screams "running." |
| `accent-dim` | `#00C288` | Hover states, secondary emphasis. |
| `accent-subtle` | `#00E5A015` | Backgrounds behind accent text. |
| `signal-red` | `#FF4D4D` | Errors, failed tasks, destructive. |
| `signal-amber` | `#FFB020` | Warnings, pending approvals. |
| `signal-blue` | `#4D9EFF` | Info, links, navigation. |

**Reasoning:** Green breaks from the hue-193 blue that reads corporate. Terminal green has instant systems recognition. High saturation against near-black canvas creates voltage without needing gradients.

### Symbol: Terminal Frame

Replaces Delta Frame. Two mirrored square brackets `[ ]` with a signal dot centered between them. Two faint horizontal traces above and below the dot represent memory lanes. The brackets are open -- the system is extensible. The dot pulses with agent state (idle: slow, working: fast), preserving V1's best brand decision.

**Why replace Delta Frame:** The open triangle reads "network node" but not "runtime." The bracket pair is more specific to Plexo's identity as a code-adjacent control plane. Every engineer recognizes `[_]` as a system prompt.

SVGs: `proposals/candidate-1/symbol.svg` (48x48), `symbol-favicon-32.svg` (32x32)

### Typography

| Role | Face | Weight | Size |
|------|------|--------|------|
| Display | JetBrains Mono | 500 | 28/32/40px |
| Heading | Geist | 500 | 18/22/26px |
| Body | IBM Plex Sans | 400 | 14px / 1.55 line |
| Mono/Data | JetBrains Mono | 400 | 13px, tabular-nums |

Display in monospace is the loudest typographic signal. Headers drop to Geist for scan speed. Body stays Plex for readability at density.

### Layout Temperature

Dense/technical. Sidebar carries weight. Default view is tabular. Cards are narrow, packed, scrollable. No hero sections in product UI. Landing page uses terminal-style progressive reveal. Information grids over whitespace. 4px gap minimum.

### Motion Character

State-only. The Terminal Frame dot breathes at 2.4s idle, 0.8s working. Loading states show a cursor-blink bar, not a spinner. Hover reveals data (tooltips, expanded rows) with 120ms ease-out. Page transitions are instant cuts -- no slides, no fades. The only cosmetic motion is the cursor blink on the landing page. Motion budget is spent entirely on communicating system state.

### Voice Samples

- **Button:** `wire model`
- **Empty state:** `no agents configured. add one to start.`
- **Error:** `connection refused: model endpoint unreachable`
- **Hero:** `the runtime your agents report to.`

### Distinctiveness Gate

**vs Joeybuilt:** Green accent, monospace display, near-black canvas. Zero overlap with warm parent brand. **PASS.**
**vs Levio:** Levio will never use terminal green or monospace headers. Different planet. **PASS.**

### Panel Comments

**Castellan:** Bracket pair is strong -- more specific than the triangle, and the dot-pulse inheritance is smart. Loses the "incomplete by design" read of the open triangle; the brackets feel closed. Worth the trade.

**Devereaux:** This is the most honest systems direction. The risk is cosplaying as a terminal instead of being a control plane. Keep the terminal energy in type and color; don't put ASCII art in the UI.

**Ade:** Monospace display is the right call for this direction. JetBrains Mono at 28px+ needs letter-spacing: -0.02em or it gets gappy. Tabular-nums everywhere finally.

**Renaud:** Green at #00E5A0 is high enough saturation. Needs a desaturated variant for large-area backgrounds or it will burn retinas on data-heavy screens. The surface stack has good step contrast.

**Marchand:** The bracket metaphor maps directly to SCL syntax -- regions are bracketed structures. This symbol encodes Plexo's specific technology, not generic infrastructure. Semiotic win.

**Pell:** Clone test: nobody mistakes this for Datadog or Grafana. The green-on-dark + brackets read "custom runtime," not "monitoring dashboard." Clear differentiation.

---

## Candidate 2: GEOMETRIC PRECISION

**Angle:** Plexo as mathematical structure. The brand communicates dimensional thinking -- layers, projections, structured cognition. Clean, cold, architecturally rigorous.

### Surface Palette

| Token | Hex | Reasoning |
|-------|-----|-----------|
| `canvas` | `#101520` | Deep navy-black. Mathematical blackboard. |
| `surface-1` | `#161D2C` | Blueprint layer one. |
| `surface-2` | `#1D2640` | Active surfaces. Blue enough to feel deliberate. |
| `surface-3` | `#243052` | Selected, focused. |
| `border` | `#253354` | Structural. Reads as construction lines. |
| `border-subtle` | `#1C2744` | Grid lines, dividers. |
| `text-primary` | `#E2E8F0` | Slate-50 equivalent. Clean. |
| `text-secondary` | `#8294B0` | Blueprint annotation tone. |
| `text-muted` | `#576A88` | Dimensional labels. |

### Accent System

| Token | Hex | Use |
|-------|-----|-----|
| `accent` | `#4DAAFC` | Primary actions. Cool electric blue, 20% more saturated than V1. Precise, not friendly. |
| `accent-dim` | `#3B8FDE` | Hover. |
| `accent-subtle` | `#4DAAFC12` | Tinted backgrounds. |
| `signal-red` | `#F43F5E` | Rose-500. Errors read urgent against blue ground. |
| `signal-amber` | `#F59E0B` | Warnings. |
| `signal-green` | `#10B981` | Success, active, healthy. |

**Reasoning:** Stays in the hue-193 territory that V1 established but pushes saturation hard. The blue reads as precision instrument, not corporate dashboard. Against the navy canvas, it has the voltage the personality brief demands.

### Symbol: Tesseract Frame

Evolves Delta Frame. Outer square with inner square rotated 45 degrees, connected at projection lines. Center node. Reads as: a 2D projection of higher-dimensional structure -- which is exactly what Plexo's SCL does (projects semantic structure into navigable space). The four connecting lines represent the four Plexo primitives: agents, memory, cognition, execution.

**Why evolve Delta Frame:** The triangle had three vertices; the tesseract has eight, representing the increased complexity Plexo manages. The projection metaphor directly maps to SCL's dimensional reduction of concept space.

SVGs: `proposals/candidate-2/symbol.svg` (48x48), `symbol-favicon-32.svg` (32x32)

### Typography

| Role | Face | Weight | Size |
|------|------|--------|------|
| Display | Geist | 600 | 28/32/40px, tracking: -0.03em |
| Heading | Geist | 500 | 18/22/26px |
| Body | IBM Plex Sans | 400 | 14px / 1.55 line |
| Mono/Data | JetBrains Mono | 400 | 13px, tabular-nums |

Geist tight-tracked for architectural precision. Heavier weight than V1 display for authority. Monospace stays in its lane (data, code, status) but appears more often than V1.

### Layout Temperature

Dense/editorial-technical. Grid-based layouts with visible structure. Sidebar and main content use a strict column system. Data tables are first-class citizens. SCL concept graph gets the most generous viewport allocation -- it is the hero surface. Cards use consistent internal grids. Generous vertical rhythm within cards, tight between them.

### Motion Character

Geometric transitions only. Elements translate on axis -- no curves, no easing overshoot. The Tesseract Frame rotates its inner square subtly on agent state change (idle: static, working: slow rotation at 8s/revolution). Hover states expand information panels with linear 100ms slides. Loading uses a rotating wireframe cube at 24px. All motion follows straight lines and right angles.

### Voice Samples

- **Button:** `configure model`
- **Empty state:** `no regions defined. create a region to structure agent cognition.`
- **Error:** `schema validation failed: field "model" required`
- **Hero:** `structured intelligence, precisely routed.`

### Distinctiveness Gate

**vs Joeybuilt:** Navy-black canvas, high-sat blue, geometric symbol. Colder than anything in the Joeybuilt family. **PASS.**
**vs Levio:** Levio's warm/light palette will share zero surface colors. The tesseract mark is unmistakably infrastructure. **PASS.**

### Panel Comments

**Castellan:** The tesseract is elegant and maps to Plexo's dimensionality well. Concern: at 16px favicon, the inner rotation may collapse into noise. Test thoroughly at small sizes.

**Devereaux:** Strongest information architecture of the three. The grid system gives this direction inherent density without feeling cramped. The blueprint color language is distinctive.

**Ade:** Geist at -0.03em tracking and weight 600 is beautiful for display. The type hierarchy is the cleanest. Push JetBrains Mono into breadcrumbs and timestamps as specified.

**Renaud:** #4DAAFC at this saturation against #101520 canvas gives excellent contrast ratios. The navy ground avoids the "generic dark mode" trap. Surface step hierarchy is well-calibrated.

**Marchand:** The tesseract-as-projection is the most intellectually satisfying symbol. It encodes SCL's core operation: projecting high-dimensional semantic space into navigable structure. The four connecting lines as four primitives may be too clever -- users won't read that without explanation.

**Pell:** Unique enough. The navy-blue palette has some overlap with Linear, but the geometric mark and information density push it clear. The concept graph as hero surface is the anti-clone move.

---

## Candidate 3: GEOLOGICAL STRATA

**Angle:** Plexo as layered substrate. The personality brief says "geological strata, not Material Design elevation." This direction takes that literally. Horizontal layers, vertical signal piercing through them. The brand communicates depth and persistence.

### Surface Palette

| Token | Hex | Reasoning |
|-------|-----|-----------|
| `canvas` | `#110E18` | Deep purple-black. Geological deep. |
| `surface-1` | `#1A1524` | First stratum. Visible separation from void. |
| `surface-2` | `#241E32` | Second stratum. Cards and panels live here. |
| `surface-3` | `#2E2640` | Active/selected. Rich enough to feel warm-adjacent without being warm. |
| `border` | `#2E2640` | Same as surface-3. Borders are strata edges. |
| `border-subtle` | `#211B2E` | Hairline geological divisions. |
| `text-primary` | `#E8E0F0` | Warm white with lavender. |
| `text-secondary` | `#9B8CB0` | Muted amethyst. |
| `text-muted` | `#6E5E85` | Deep strata label tone. |

### Accent System

| Token | Hex | Use |
|-------|-----|-----|
| `accent` | `#E04AFF` | Electric violet. Signal piercing through layers. Unmistakable, high energy, zero corporate read. |
| `accent-dim` | `#C240E0` | Hover. |
| `accent-subtle` | `#E04AFF10` | Tinted backgrounds. |
| `signal-red` | `#FF5555` | Errors. |
| `signal-amber` | `#FFAA33` | Warnings. |
| `signal-green` | `#33DD88` | Success, active. |

**Reasoning:** Violet breaks completely from the blue/green territory every infrastructure tool occupies. The purple-black canvas is geological -- deep, layered, ancient. The electric violet accent acts as a vertical signal cutting through horizontal strata, which is exactly how agents traverse Plexo's memory and cognition layers.

### Symbol: Strata Mark

Three horizontal rectangles (narrow, wide, narrow) with a vertical dashed line piercing all three. Signal nodes at each intersection point. The layers represent Plexo's three persistence tiers: ephemeral (session), working (task), and deep (memory). The vertical pierce is the agent traversing all layers simultaneously.

**Why replace Delta Frame:** The triangle is flat -- one plane. Plexo's entire identity is about layers and depth. The strata mark makes depth the primary visual concept. The pierce-through signal communicates what no other AI platform's mark does: vertical integration across cognitive layers.

SVGs: `proposals/candidate-3/symbol.svg` (48x48), `symbol-favicon-32.svg` (32x32)

### Typography

| Role | Face | Weight | Size |
|------|------|--------|------|
| Display | Geist | 500 | 28/32/40px, tracking: -0.02em |
| Heading | IBM Plex Sans | 500 | 18/22/26px |
| Body | IBM Plex Sans | 400 | 14px / 1.55 line |
| Mono/Data | JetBrains Mono | 400 | 13px, tabular-nums |

Geist display, Plex for everything readable. Monospace is data-only here -- the geological direction carries enough visual weight without monospace headers. Cleaner reading experience for the densest layouts.

### Layout Temperature

Dense/stratified. Horizontal bands organize information. The sidebar is a vertical stack of horizontal sections. Main content uses full-width horizontal rows that echo the strata metaphor. SCL regions visualized as horizontal layers with vertical connection indicators. Tables emphasize row bands with alternating strata tones. The overall feeling: looking at a cross-section of running infrastructure.

### Motion Character

Vertical only. The Strata Mark's signal nodes pulse sequentially top-to-bottom (idle: 3s cycle, working: 1s cycle), communicating signal propagation through layers. Loading states use a vertical scan line moving downward. Hover states reveal content by expanding the stratum height -- horizontal expansion, never lateral slide. Transitions between views use a vertical wipe. All motion reinforces the top-to-bottom depth metaphor.

### Voice Samples

- **Button:** `add layer`
- **Empty state:** `no memory persisted. agents start building context on first run.`
- **Error:** `layer breach: agent exceeded memory allocation`
- **Hero:** `the layers your intelligence runs through.`

### Distinctiveness Gate

**vs Joeybuilt:** Purple-black canvas, violet accent. Maximally distant from any warm parent brand. **PASS.**
**vs Levio:** Levio will be light and warm. This is the darkest, most saturated direction. **PASS.**

### Panel Comments

**Castellan:** The strata mark is the most conceptually original. Three layers + vertical pierce tells Plexo's story in one glyph. Risk: at 16px the dashed line may disappear. Use solid line in favicon variant.

**Devereaux:** The horizontal-band layout system is genuinely different from any dashboard I can reference. It enforces a unique information architecture. The geological metaphor must stay structural, not decorative -- no rock textures.

**Ade:** Plex for headings + body gives the most readable dense layouts. The monospace restraint is correct here -- the strata visual language does enough differentiation work. Tabular-nums in JetBrains Mono still everywhere data appears.

**Renaud:** Violet at #E04AFF is a bold departure. Against #110E18 it has excellent luminance contrast. The purple-black canvas avoids "dark mode = gray" while staying dark. The signal colors need testing against the violet ground -- amber and green should stay clear.

**Marchand:** The layers-as-persistence-tiers is a precise semiotic mapping. This is the only candidate where the symbol directly encodes Plexo's memory architecture. The vertical pierce as agent-traversal is readable without explanation. Strongest narrative of the three.

**Pell:** Nobody will mistake this for any existing tool. The violet accent alone separates it from every infrastructure product. The strata layout pattern is ownable. Strongest anti-clone position, but also highest risk -- it is the most unfamiliar visual language.

---

*End of proposals. Next: select one direction or hybrid, then proceed to 2-TOKENS.md.*
