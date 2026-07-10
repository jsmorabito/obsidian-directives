/**
 * handlers/tab.ts
 *
 * Implements the :::tab directive — a scrollable monospace guitar-tab display
 * with a moving playhead.
 *
 * Syntax:
 *   :::tab[My Song]{bpm=120 cpb=2 audio="recording.mp3"}
 *   e|---0---2---3---|---0---|
 *   B|---------------|---1---|
 *   G|---------------|------|
 *   D|---------------|------|
 *   A|---------------|------|
 *   E|---3-----------|------|
 *   :::
 *
 * Attributes:
 *   bpm   — beats per minute (default 120).  Controls playhead speed.
 *   cpb   — characters per beat (default 2).  Tune this to match your
 *           tab's subdivision density (e.g. 2 for 8th-notes, 4 for 16ths).
 *   audio — src matching a :::audio directive on the same note.
 *           When set the playhead syncs to audio:timeupdate events;
 *           the play button becomes a read-only indicator.
 *
 * Spec: §4.3 and §9.3
 *
 * Key design decisions:
 *
 *  Standalone mode (no audio attr):
 *    The play/pause button starts a requestAnimationFrame loop that advances
 *    the playhead at (bpm / 60 * cpb) characters per second.  The BPM
 *    spinner is live-editable so the user can tune sync without touching
 *    the raw Markdown.
 *
 *  Audio-sync mode (audio attr set):
 *    The playhead position is driven entirely by audio:timeupdate events
 *    (exact formula: charPos = time * bpm / 60 * cpb).  No RAF loop is
 *    needed.  audio:seek also snaps the playhead immediately.  The play
 *    button mirrors the audio state but does not control standalone playback.
 *
 *  Auto-scroll:
 *    On every playhead update the widget checks whether the playhead
 *    has gone past the visible right edge of the container and scrolls
 *    to keep it centred.  On a backwards seek it also scrolls left.
 *
 *  Playhead position:
 *    The playhead div uses `left: Xch` in CSS.  Inside a monospace
 *    container `1ch` equals one character-width, so the mapping is exact.
 *    The pixel position for scroll calculations is read from
 *    playheadEl.offsetLeft (which returns content-relative px).
 */

import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { eventBusField } from '../core/event-bus'
import type { EventBus } from '../core/event-bus'
import type { DirectivesSettings } from '../settings'

// ---------------------------------------------------------------------------
// TabWidget
// ---------------------------------------------------------------------------

class TabWidget extends DirectiveWidget {
  private cleanups: Array<() => void> = []

  // Playback state — mutable during the widget's lifetime
  private charPos   = 0
  private isPlaying = false
  private rafId:    number | null = null
  private lastTs:   number | null = null

  // Attributes — may be tweaked live via the BPM spinner
  private bpm: number
  private cpb: number

  constructor(
    private readonly directive: ParsedDirective,
    private readonly bus: EventBus,
    private readonly settings: Pick<DirectivesSettings, 'defaultBpm' | 'defaultCpb'>,
  ) {
    super()
    this.bpm = Math.max(20, parseInt(directive.attributes['bpm'] ?? '', 10) || settings.defaultBpm)
    this.cpb = Math.max(1,  parseInt(directive.attributes['cpb'] ?? '', 10) || settings.defaultCpb)
  }

  eq(other: TabWidget): boolean {
    if (!(other instanceof TabWidget)) return false
    return (
      this.directive.body                  === other.directive.body &&
      this.directive.label                 === other.directive.label &&
      this.directive.attributes['bpm']     === other.directive.attributes['bpm'] &&
      this.directive.attributes['cpb']     === other.directive.attributes['cpb'] &&
      this.directive.attributes['audio']   === other.directive.attributes['audio']
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const audioSrc  = this.directive.attributes['audio']
    const body      = this.directive.body ?? ''
    const standalone = !audioSrc

    // ── Outer wrapper ──────────────────────────────────────────────────────
    const wrap = activeDocument.createDiv()
    wrap.className = 'directive-widget directive-widget--tab'

    // Required: click-to-edit convention (moves cursor into block so the
    // StateField removes the decoration and reveals raw Markdown).
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    // ── Header ─────────────────────────────────────────────────────────────
    const { headerEl, playBtn, bpmInput } = this.buildHeader(audioSrc)
    wrap.appendChild(headerEl)

    // ── Tab display ────────────────────────────────────────────────────────
    const { displayEl, playheadEl } = this.buildTabDisplay(body)
    wrap.appendChild(displayEl)

    // ── Shared playhead update function ────────────────────────────────────
    const updatePlayhead = (): void => {
      playheadEl.style.left = `${this.charPos}ch`

      // Auto-scroll to keep the playhead visible.
      // playheadEl.offsetLeft gives content-relative px (ignores scrollLeft).
      const pLeft = playheadEl.offsetLeft
      const margin = 80

      if (pLeft > displayEl.scrollLeft + displayEl.clientWidth - margin) {
        // Playhead near right edge — scroll right.
        displayEl.scrollLeft = Math.max(0, pLeft - margin)
      } else if (pLeft < displayEl.scrollLeft + 20) {
        // Playhead near left edge (backwards seek) — scroll left.
        displayEl.scrollLeft = Math.max(0, pLeft - 20)
      }
    }

    // ── Mode-specific wiring ───────────────────────────────────────────────
    if (standalone) {
      this.wireStandalone(playBtn, bpmInput, updatePlayhead)
    } else {
      this.wireAudioSync(audioSrc, playBtn, bpmInput, updatePlayhead)
    }

    return wrap
  }

  // ── Standalone (RAF-driven) ─────────────────────────────────────────────

  private wireStandalone(
    playBtn: HTMLButtonElement,
    bpmInput: HTMLInputElement,
    updatePlayhead: () => void,
  ): void {
    const rafStep = (ts: number): void => {
      if (this.lastTs !== null) {
        const dt = (ts - this.lastTs) / 1000
        this.charPos += dt * this.bpm / 60 * this.cpb
        updatePlayhead()
      }
      this.lastTs = ts
      this.rafId  = window.requestAnimationFrame(rafStep)
    }

    const start = (): void => {
      if (this.rafId !== null) return
      this.lastTs    = null
      this.isPlaying = true
      playBtn.textContent = '⏸'
      this.rafId = window.requestAnimationFrame(rafStep)
    }

    const stop = (): void => {
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId)
        this.rafId = null
      }
      this.lastTs    = null
      this.isPlaying = false
      playBtn.textContent = '▶'
    }

    playBtn.addEventListener('click', () => {
      if (this.isPlaying) stop(); else start()
    })

    bpmInput.addEventListener('input', () => {
      this.bpm = Math.max(20, parseInt(bpmInput.value, 10) || 120)
    })

    // Cleanup: stop RAF if the widget is destroyed while playing.
    this.cleanups.push(() => stop())
  }

  // ── Audio-sync (event-bus-driven) ──────────────────────────────────────

  private wireAudioSync(
    audioSrc: string,
    playBtn: HTMLButtonElement,
    bpmInput: HTMLInputElement,
    updatePlayhead: () => void,
  ): void {
    // The play button is a read-only mirror of the audio player state.
    // It doesn't start/stop standalone playback.
    playBtn.disabled = true
    playBtn.title    = 'Synced to audio player'
    playBtn.classList.add('directive-tab-synced')

    const unsubPlay = this.bus.subscribe('audio:play', ({ src }) => {
      if (src !== audioSrc) return
      this.isPlaying      = true
      playBtn.textContent = '⏸'
    })

    const unsubPause = this.bus.subscribe('audio:pause', ({ src }) => {
      if (src !== audioSrc) return
      this.isPlaying      = false
      playBtn.textContent = '▶'
    })

    const unsubTime = this.bus.subscribe('audio:timeupdate', ({ src, time }) => {
      if (src !== audioSrc) return
      this.charPos = time * this.bpm / 60 * this.cpb
      updatePlayhead()
    })

    const unsubSeek = this.bus.subscribe('audio:seek', ({ src, time }) => {
      if (src !== audioSrc) return
      this.charPos = time * this.bpm / 60 * this.cpb
      updatePlayhead()
    })

    // BPM spinner still live-editable so the user can tune sync.
    bpmInput.addEventListener('input', () => {
      this.bpm = Math.max(20, parseInt(bpmInput.value, 10) || 120)
    })

    this.cleanups.push(unsubPlay, unsubPause, unsubTime, unsubSeek)
  }

  // ── DOM builders ────────────────────────────────────────────────────────

  private buildHeader(audioSrc: string | undefined): {
    headerEl: HTMLElement
    playBtn: HTMLButtonElement
    bpmInput: HTMLInputElement
  } {
    const headerEl = activeDocument.createDiv()
    headerEl.className = 'directive-tab-header'
    // Stop header interactions from bubbling to the wrap's cursor-move handler.
    headerEl.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    // Play / pause button
    const playBtn = activeDocument.createEl('button')
    playBtn.className   = 'directive-transport__play-btn'
    playBtn.textContent = '▶'
    playBtn.setAttribute('aria-label', audioSrc ? 'Synced to audio' : 'Play/pause tab')

    // Song title label
    const labelEl = activeDocument.createSpan()
    labelEl.className   = 'directive-tab-label'
    labelEl.textContent = this.directive.label ?? ''

    // BPM control
    const bpmControl = activeDocument.createDiv()
    bpmControl.className = 'directive-bpm-control'

    const bpmInput = activeDocument.createEl('input')
    bpmInput.type  = 'number'
    bpmInput.min   = '20'
    bpmInput.max   = '300'
    bpmInput.value = String(this.bpm)
    bpmInput.setAttribute('aria-label', 'BPM')

    const bpmLabel = activeDocument.createSpan()
    bpmLabel.textContent = 'BPM'

    bpmControl.appendChild(bpmInput)
    bpmControl.appendChild(bpmLabel)

    headerEl.appendChild(playBtn)
    headerEl.appendChild(labelEl)
    headerEl.appendChild(bpmControl)

    return { headerEl, playBtn, bpmInput }
  }

  private buildTabDisplay(body: string): {
    displayEl: HTMLElement
    playheadEl: HTMLElement
  } {
    const displayEl = activeDocument.createDiv()
    displayEl.className = 'directive-tab-display'
    // Stop scroll/click interactions from bubbling to the cursor-move handler.
    displayEl.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    // Vertical playhead line — absolutely positioned inside displayEl
    const playheadEl = activeDocument.createDiv()
    playheadEl.className = 'directive-tab-playhead'
    displayEl.appendChild(playheadEl)

    // Tab content
    const pre = activeDocument.createEl('pre')
    pre.className   = 'directive-tab-pre'
    pre.textContent = body
    displayEl.appendChild(pre)

    return { displayEl, playheadEl }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  destroy(_dom: HTMLElement): void {
    // Stop RAF loop if running (standalone mode).
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups  = []
    this.isPlaying = false
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the tab directive handler.
 * Pass the live settings object — changes take effect on next widget render.
 */
export function createTabHandler(
  settings: Pick<DirectivesSettings, 'defaultBpm' | 'defaultCpb'>,
): DirectiveHandler {
  return {
    name: 'tab',

    render(directive: ParsedDirective, state: EditorState): DirectiveWidget {
      const bus = state.field(eventBusField)
      return new TabWidget(directive, bus, settings)
    },
  }
}
