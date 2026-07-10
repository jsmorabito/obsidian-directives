/**
 * handlers/chords.ts
 *
 * Implements the :::chords directive — an SVG chord-diagram grid with
 * optional audio-timeline synchronisation.
 *
 * Syntax:
 *   :::chords[Song Title]{layout="grid" audio="recording.mp3"}
 *   [0:00] G
 *   [0:08] C
 *   [0:16] D
 *   Am
 *   :::
 *
 * Attributes:
 *   layout  — "grid" (default) | "horizontal" | "vertical" | "text"
 *   audio   — src matching the :::audio directive on the same note
 *             (chord clicks will seek that player via audio:seek)
 *
 * Spec: §4.2 and §9.2
 *
 * Key design decisions:
 *
 *  - Chord definitions store absolute fret numbers.  The renderer converts
 *    them to visual rows using:  visualRow = fret − baseFret + 1  (1-indexed).
 *
 *  - The SVG is created with activeDocument.createElementNS so CSS variables
 *    (var(--interactive-accent), etc.) resolve correctly in the live DOM.
 *
 *  - ChordWidget subscribes to audio:timeupdate to highlight the active chord
 *    as the track plays.  Clicking a chord with a timestamp publishes
 *    audio:seek so the audio handler jumps to that position.
 *
 *  - Event listener cleanup is handled identically to the audio handler:
 *    stored in this.cleanups[], called in destroy().
 */

import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { eventBusField } from '../core/event-bus'
import type { EventBus } from '../core/event-bus'
import type { DirectivesSettings } from '../settings'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChordDef {
  /**
   * Absolute fret number for each of the 6 strings (low E → high e).
   *   -1 = muted (×)
   *    0 = open (○)
   *   >0 = fret number
   */
  strings: [number, number, number, number, number, number]
  /**
   * Optional barre bar across strings `from`–`to` (0-indexed) at absolute
   * `fret`.  Strings within the barre range at that fret are not given
   * individual dots.
   */
  barre?: { fret: number; from: number; to: number }
  /**
   * First fret shown in the diagram window.  Defaults to 1.
   * When > 1 the nut line becomes a regular fret line and a "Nfr" label
   * is added to the right of the diagram.
   */
  baseFret?: number
}

interface ChordEntry {
  name: string
  time?: number   // seconds (from [m:ss] prefix)
  raw?: string    // original "[m:ss]" string for display
}

type Layout = 'grid' | 'horizontal' | 'vertical' | 'text'

// ---------------------------------------------------------------------------
// Chord database  (~45 common guitar chords, standard tuning)
// ---------------------------------------------------------------------------

const CHORDS = new Map<string, ChordDef>([
  // ── Open major ──────────────────────────────────────────────────────────
  ['G',      { strings: [3, 2, 0, 0, 0, 3] }],
  ['C',      { strings: [-1, 3, 2, 0, 1, 0] }],
  ['D',      { strings: [-1, -1, 0, 2, 3, 2] }],
  ['A',      { strings: [-1, 0, 2, 2, 2, 0] }],
  ['E',      { strings: [0, 2, 2, 1, 0, 0] }],

  // ── Barre major ─────────────────────────────────────────────────────────
  ['F',      { strings: [1, 1, 2, 3, 3, 1],
               barre: { fret: 1, from: 0, to: 5 } }],
  ['B',      { strings: [-1, 2, 4, 4, 4, 2],
               barre: { fret: 2, from: 1, to: 5 }, baseFret: 2 }],
  ['Bb',     { strings: [-1, 1, 3, 3, 3, 1],
               barre: { fret: 1, from: 1, to: 5 } }],

  // ── Open minor ──────────────────────────────────────────────────────────
  ['Am',     { strings: [-1, 0, 2, 2, 1, 0] }],
  ['Em',     { strings: [0, 2, 2, 0, 0, 0] }],
  ['Dm',     { strings: [-1, -1, 0, 2, 3, 1] }],

  // ── Barre minor ─────────────────────────────────────────────────────────
  ['Fm',     { strings: [1, 3, 3, 1, 1, 1],
               barre: { fret: 1, from: 0, to: 5 } }],
  ['Bm',     { strings: [-1, 2, 4, 4, 3, 2],
               barre: { fret: 2, from: 1, to: 5 }, baseFret: 2 }],
  ['F#m',    { strings: [2, 4, 4, 2, 2, 2],
               barre: { fret: 2, from: 0, to: 5 }, baseFret: 2 }],

  // ── Dominant 7ths ───────────────────────────────────────────────────────
  ['G7',     { strings: [3, 2, 0, 0, 0, 1] }],
  ['C7',     { strings: [-1, 3, 2, 3, 1, 0] }],
  ['D7',     { strings: [-1, -1, 0, 2, 1, 2] }],
  ['A7',     { strings: [-1, 0, 2, 0, 2, 0] }],
  ['E7',     { strings: [0, 2, 0, 1, 0, 0] }],
  ['B7',     { strings: [-1, 2, 1, 2, 0, 2] }],
  ['F7',     { strings: [1, 1, 2, 1, 1, 1],
               barre: { fret: 1, from: 0, to: 5 } }],

  // ── Minor 7ths ──────────────────────────────────────────────────────────
  ['Am7',    { strings: [-1, 0, 2, 0, 1, 0] }],
  ['Em7',    { strings: [0, 2, 2, 0, 3, 0] }],
  ['Dm7',    { strings: [-1, -1, 0, 2, 1, 1] }],
  ['Bm7',    { strings: [-1, 2, 0, 2, 0, 2] }],

  // ── Major 7ths ──────────────────────────────────────────────────────────
  ['Cmaj7',  { strings: [-1, 3, 2, 0, 0, 0] }],
  ['Gmaj7',  { strings: [3, 2, 0, 0, 0, 2] }],
  ['Amaj7',  { strings: [-1, 0, 2, 1, 2, 0] }],
  ['Emaj7',  { strings: [0, 2, 1, 1, 0, 0] }],
  ['Fmaj7',  { strings: [-1, -1, 3, 2, 1, 0] }],
  ['Dmaj7',  { strings: [-1, -1, 0, 2, 2, 2] }],

  // ── Suspended ───────────────────────────────────────────────────────────
  ['Dsus2',  { strings: [-1, -1, 0, 2, 3, 0] }],
  ['Dsus4',  { strings: [-1, -1, 0, 2, 3, 3] }],
  ['Asus2',  { strings: [-1, 0, 2, 2, 0, 0] }],
  ['Asus4',  { strings: [-1, 0, 2, 2, 3, 0] }],
  ['Esus4',  { strings: [0, 2, 2, 2, 0, 0] }],
  ['Gsus4',  { strings: [3, 3, 0, 0, 1, 3] }],

  // ── Add chords ──────────────────────────────────────────────────────────
  ['Cadd9',  { strings: [-1, 3, 2, 0, 3, 3] }],
  ['Gadd9',  { strings: [3, 0, 0, 0, 0, 3] }],
  ['Dadd9',  { strings: [-1, -1, 0, 2, 3, 0] }],

  // ── Slash chords ────────────────────────────────────────────────────────
  ['G/B',    { strings: [-1, 2, 0, 0, 0, 3] }],
  ['D/F#',   { strings: [2, 0, 0, 2, 3, 2] }],
  ['C/G',    { strings: [3, 3, 2, 0, 1, 0] }],
  ['Am/E',   { strings: [0, 0, 2, 2, 1, 0] }],
])

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

// Matches "[m:ss] ChordName" — timestamp + exactly one chord name.
const TS_LINE_RE = /^\[(\d+):(\d{2})\]\s*(\S+)/

function parseChordEntries(body: string): ChordEntry[] {
  const entries: ChordEntry[] = []
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const m = TS_LINE_RE.exec(trimmed)
    if (m) {
      const min = parseInt(m[1] ?? '0', 10)
      const sec = parseInt(m[2] ?? '0', 10)
      entries.push({
        name: m[3] ?? '',
        time: min * 60 + sec,
        raw: `[${m[1]}:${m[2]}]`,
      })
    } else {
      // Bare chord names — allow multiple space-separated names per line.
      for (const word of trimmed.split(/\s+/)) {
        if (word) entries.push({ name: word })
      }
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// SVG fretboard renderer
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'

type SvgAttrs = Record<string, string | number>

function svgEl(tag: string, attrs: SvgAttrs): Element {
  const el = activeDocument.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

// Layout constants (SVG user-units, viewBox 0 0 80 98)
const S_XS     = [10, 22, 34, 46, 58, 70] as const  // string X (low E → high e)
const FRET_YS  = [20, 37, 54, 71, 88]     as const  // 5 fret lines → 4 frets
const DOT_YS   = [28, 45, 62, 79]         as const  // dot centres (rows 1–4)
const MARKER_Y = 10                                  // open/muted mark Y
const DOT_R    = 5                                   // finger dot radius

function renderChordSVG(def: ChordDef): Element {
  const base = def.baseFret ?? 1

  const svg = svgEl('svg', {
    viewBox: '0 0 80 98',
    width: 80,
    height: 98,
    'aria-hidden': 'true',
    class: 'directive-chord-svg',
  })

  // Vertical string lines
  for (const x of S_XS) {
    svg.appendChild(svgEl('line', {
      x1: x, y1: FRET_YS[0], x2: x, y2: FRET_YS[4],
      stroke: 'var(--text-faint)', 'stroke-width': 1,
    }))
  }

  // Horizontal fret lines (nut is thicker when at actual fret 1)
  for (let i = 0; i < FRET_YS.length; i++) {
    const y = FRET_YS[i]!
    const isNut = i === 0 && base === 1
    svg.appendChild(svgEl('line', {
      x1: S_XS[0], y1: y, x2: S_XS[5], y2: y,
      stroke: 'var(--text-normal)',
      'stroke-width': isNut ? 3 : 1,
      'stroke-linecap': 'square',
    }))
  }

  // baseFret label when the window doesn't start at fret 1
  if (base > 1) {
    const lbl = svgEl('text', {
      x: S_XS[5] + 4,
      y: DOT_YS[0],
      'font-size': 8,
      fill: 'var(--text-muted)',
      'dominant-baseline': 'middle',
    })
    lbl.textContent = `${base}fr`
    svg.appendChild(lbl)
  }

  // Barre bar
  if (def.barre) {
    const visualRow = def.barre.fret - base  // 0-indexed
    const y = DOT_YS[visualRow]
    if (y !== undefined) {
      const x1 = S_XS[def.barre.from] ?? S_XS[0]
      const x2 = S_XS[def.barre.to]   ?? S_XS[5]
      svg.appendChild(svgEl('rect', {
        x:      x1 - DOT_R,
        y:      y  - DOT_R,
        width:  (x2 - x1) + DOT_R * 2,
        height: DOT_R * 2,
        rx:     DOT_R,
        fill:   'var(--interactive-accent)',
        opacity: 0.9,
      }))
    }
  }

  // Per-string markers
  for (let i = 0; i < 6; i++) {
    const x    = S_XS[i]!
    const fret = def.strings[i]
    if (fret === undefined) continue

    if (fret === -1) {
      // Muted: ×
      const d = 3
      for (const [dx1, dy1, dx2, dy2] of [
        [-d, -d, d, d] as const,
        [ d, -d, -d, d] as const,
      ]) {
        svg.appendChild(svgEl('line', {
          x1: x + dx1, y1: MARKER_Y + dy1,
          x2: x + dx2, y2: MARKER_Y + dy2,
          stroke: 'var(--text-muted)',
          'stroke-width': 1.5,
          'stroke-linecap': 'round',
        }))
      }
    } else if (fret === 0) {
      // Open: ○
      svg.appendChild(svgEl('circle', {
        cx: x, cy: MARKER_Y, r: DOT_R - 1,
        fill: 'none',
        stroke: 'var(--text-muted)',
        'stroke-width': 1.5,
      }))
    } else {
      // Fretted dot — skip if the barre already covers this string+fret
      const visualRow = fret - base  // 0-indexed
      const coveredByBarre =
        def.barre !== undefined &&
        fret === def.barre.fret &&
        i >= def.barre.from &&
        i <= def.barre.to
      if (!coveredByBarre && visualRow >= 0 && visualRow <= 3) {
        const y = DOT_YS[visualRow]
        if (y !== undefined) {
          svg.appendChild(svgEl('circle', {
            cx: x, cy: y, r: DOT_R,
            fill: 'var(--interactive-accent)',
          }))
        }
      }
    }
  }

  return svg
}

// ---------------------------------------------------------------------------
// Active-chord tracking helper
// ---------------------------------------------------------------------------

function getActiveChordIndex(time: number, entries: ChordEntry[]): number {
  let active = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e?.time !== undefined && e.time <= time) active = i
  }
  return active
}

// ---------------------------------------------------------------------------
// ChordWidget
// ---------------------------------------------------------------------------

class ChordWidget extends DirectiveWidget {
  private cleanups: Array<() => void> = []

  constructor(
    private readonly directive: ParsedDirective,
    private readonly bus: EventBus,
    private readonly settings: Pick<DirectivesSettings, 'defaultChordLayout'>,
  ) {
    super()
  }

  eq(other: ChordWidget): boolean {
    if (!(other instanceof ChordWidget)) return false
    return (
      this.directive.body                      === other.directive.body &&
      this.directive.label                     === other.directive.label &&
      this.directive.attributes['layout']      === other.directive.attributes['layout'] &&
      this.directive.attributes['audio']       === other.directive.attributes['audio']
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const layout   = (this.directive.attributes['layout'] ?? this.settings.defaultChordLayout) as Layout
    const audioSrc = this.directive.attributes['audio']
    const entries  = parseChordEntries(this.directive.body ?? '')

    const wrap = activeDocument.createDiv()
    wrap.className = 'directive-widget directive-widget--chords'

    // Required: click anywhere on the widget puts cursor inside the block,
    // causing the StateField to remove the decoration and show raw Markdown.
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    // Optional title label
    if (this.directive.label) {
      const header = activeDocument.createDiv()
      header.className = 'directive-chords-header'
      header.textContent = this.directive.label
      wrap.appendChild(header)
    }

    // Chord grid / row / column / text container
    const container = activeDocument.createDiv()
    container.className = this.layoutClass(layout)
    wrap.appendChild(container)

    // Build chord cards
    const cardEls: HTMLElement[] = []
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry) continue
      const card = this.buildCard(entry, audioSrc, layout)
      // Stop card interactions from bubbling to the wrap's cursor-move handler.
      card.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
      cardEls.push(card)
      container.appendChild(card)
    }

    // Subscribe to audio:timeupdate → highlight the currently active chord
    const unsubTime = this.bus.subscribe('audio:timeupdate', ({ src, time }) => {
      // If audio src is specified, only respond to events from that file.
      if (audioSrc && src !== audioSrc) return
      const newActive = getActiveChordIndex(time, entries)
      const prevActive = cardEls.findIndex(c => c.classList.contains('directive-chord-card--active'))
      if (newActive === prevActive) return
      cardEls[prevActive]?.classList.remove('directive-chord-card--active')
      cardEls[newActive]?.classList.add('directive-chord-card--active')
      // Keep the active card visible in horizontal scroll mode.
      if (layout === 'horizontal') {
        cardEls[newActive]?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
          inline: 'nearest',
        })
      }
    })
    this.cleanups.push(unsubTime)

    return wrap
  }

  private layoutClass(layout: Layout): string {
    switch (layout) {
      case 'horizontal': return 'directive-chords-horizontal'
      case 'vertical':   return 'directive-chords-vertical'
      case 'text':       return 'directive-chords-text'
      default:           return 'directive-chords-grid'
    }
  }

  private buildCard(
    entry: ChordEntry,
    audioSrc: string | undefined,
    layout: Layout,
  ): HTMLElement {
    const card = activeDocument.createDiv()
    card.className = 'directive-chord-card'
    card.title     = entry.name

    // Clicking a chord with a timestamp publishes audio:seek so the audio
    // handler jumps to that position.
    if (entry.time !== undefined && audioSrc) {
      card.addEventListener('click', () => {
        this.bus.publish('audio:seek', {
          src:  audioSrc,
          time: entry.time!,
        })
      })
      card.classList.add('directive-chords-clickable')
    }

    // SVG fretboard diagram (all layouts except text)
    if (layout !== 'text') {
      const def = CHORDS.get(entry.name)
      if (def) {
        card.appendChild(renderChordSVG(def))
      } else {
        card.appendChild(this.buildUnknownPlaceholder())
      }
    }

    // Chord name
    const nameEl = activeDocument.createSpan()
    nameEl.className   = 'directive-chord-name'
    nameEl.textContent = entry.name
    card.appendChild(nameEl)

    // Timestamp badge
    if (entry.raw) {
      const ts = activeDocument.createSpan()
      ts.className   = 'directive-chord-timestamp'
      ts.textContent = entry.raw
      card.appendChild(ts)
    }

    return card
  }

  /** Placeholder shown for chords not found in the built-in database. */
  private buildUnknownPlaceholder(): HTMLElement {
    const el = activeDocument.createDiv()
    el.className = 'directive-chord-unknown'
    el.textContent = '?'
    return el
  }

  destroy(_dom: HTMLElement): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the chords directive handler.
 * Pass the live settings object — changes take effect on next widget render.
 */
export function createChordsHandler(
  settings: Pick<DirectivesSettings, 'defaultChordLayout'>,
): DirectiveHandler {
  return {
    name: 'chords',

    render(directive: ParsedDirective, state: EditorState): DirectiveWidget {
      const bus = state.field(eventBusField)
      return new ChordWidget(directive, bus, settings)
    },
  }
}
