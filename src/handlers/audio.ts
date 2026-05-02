/**
 * handlers/audio.ts
 *
 * Implements the :::audio directive — a local audio player with a
 * synchronized, clickable timestamp list.
 *
 * Syntax:
 *   :::audio[Title]{src="recording.mp3" loop=true}
 *   [0:00] Intro
 *   [0:32] Verse
 *   :::
 *
 * Spec: §4.1 and §9.1
 *
 * Key architectural decisions:
 *
 *  - The HTMLAudioElement is cached at module level, keyed by resource URL.
 *    This means the element (and its playback state) survives widget
 *    recreation when the cursor enters/exits the block. Playback is never
 *    interrupted by editing (spec §10.4).
 *
 *  - Event listeners are attached to the audio element in toDOM() and removed
 *    in destroy(). The audio element itself is NOT destroyed on widget teardown.
 *
 *  - disposeAllAudio() is called from the plugin's onunload() to release all
 *    cached audio elements.
 */

import { App, TFile } from 'obsidian'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { eventBusField } from '../core/event-bus'
import type { EventBus } from '../core/event-bus'

// ---------------------------------------------------------------------------
// Timestamp helpers
// ---------------------------------------------------------------------------

interface TimestampEntry {
  time: number    // seconds
  label: string
  raw: string     // "[m:ss]" as it appears in source
}

const TS_LINE_RE = /^\[(\d+):(\d{2})\]\s*(.*)/

function parseTimestamps(body: string): TimestampEntry[] {
  const entries: TimestampEntry[] = []
  for (const line of body.split('\n')) {
    const m = TS_LINE_RE.exec(line.trim())
    if (!m) continue
    const min = parseInt(m[1] ?? '0', 10)
    const sec = parseInt(m[2] ?? '0', 10)
    entries.push({
      time: min * 60 + sec,
      label: m[3] ?? '',
      raw: `[${m[1]}:${m[2]}]`,
    })
  }
  return entries
}

function formatTime(s: number): string {
  if (!isFinite(s) || isNaN(s)) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Returns the index of the last timestamp whose time ≤ current time. */
function getActiveIndex(time: number, entries: TimestampEntry[]): number {
  let active = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry !== undefined && entry.time <= time) active = i
  }
  return active
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function resolveAudioFile(src: string, app: App): TFile | null {
  if (!src.trim()) return null
  // Try exact vault path first (handles vault-relative paths).
  const byPath = app.vault.getAbstractFileByPath(src)
  if (byPath instanceof TFile) return byPath
  // Fall back to Obsidian's link resolver (handles bare filenames).
  return app.metadataCache.getFirstLinkpathDest(src, '') ?? null
}

// ---------------------------------------------------------------------------
// Module-level audio cache
// Keyed by resource URL (from app.vault.getResourcePath).
// Survives widget recreation so playback is never interrupted by editing.
// ---------------------------------------------------------------------------

const AUDIO_CACHE = new Map<string, HTMLAudioElement>()

function getOrCreateAudio(resourceUrl: string): HTMLAudioElement {
  let audio = AUDIO_CACHE.get(resourceUrl)
  if (!audio) {
    audio = new Audio(resourceUrl)
    audio.preload = 'metadata'
    AUDIO_CACHE.set(resourceUrl, audio)
  }
  return audio
}

/** Release all cached audio elements. Call from plugin onunload(). */
export function disposeAllAudio(): void {
  for (const audio of AUDIO_CACHE.values()) {
    audio.pause()
    audio.src = ''
  }
  AUDIO_CACHE.clear()
}

// ---------------------------------------------------------------------------
// AudioWidget
// ---------------------------------------------------------------------------

class AudioWidget extends DirectiveWidget {
  // Event listener cleanup fns — populated in toDOM(), called in destroy().
  private cleanups: Array<() => void> = []

  constructor(
    private readonly directive: ParsedDirective,
    private readonly bus: EventBus,
    private readonly app: App,
  ) {
    super()
  }

  eq(other: AudioWidget): boolean {
    if (!(other instanceof AudioWidget)) return false
    return (
      this.directive.attributes['src'] === other.directive.attributes['src'] &&
      this.directive.body               === other.directive.body &&
      this.directive.label              === other.directive.label
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const src  = this.directive.attributes['src'] ?? ''

    const wrap = document.createElement('div')
    wrap.className = 'directive-widget directive-widget--audio'

    // Required convention: clicking the widget moves cursor into the block
    // so the block StateField reveals raw Markdown for editing.
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    // --- Resolve file ---
    const file = resolveAudioFile(src, this.app)
    if (!file) {
      wrap.appendChild(this.buildErrorState(src))
      return wrap
    }

    const resourceUrl = this.app.vault.getResourcePath(file)
    const audio       = getOrCreateAudio(resourceUrl)
    audio.loop        = this.directive.attributes['loop'] === 'true'

    const timestamps = parseTimestamps(this.directive.body ?? '')

    wrap.appendChild(this.buildTransport(audio, src, timestamps, wrap))
    wrap.appendChild(this.buildTimestampList(audio, src, timestamps))

    return wrap
  }

  // -------------------------------------------------------------------------
  // Error state
  // -------------------------------------------------------------------------

  private buildErrorState(src: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'directive-widget--error'

    const icon = document.createElement('span')
    icon.className = 'directive-error-icon'
    icon.textContent = '⚠'

    const msg = document.createElement('span')
    msg.className = 'directive-error-msg'
    msg.textContent = src.trim()
      ? `Audio file not found: ${src}`
      : 'Missing src attribute'

    row.appendChild(icon)
    row.appendChild(msg)
    return row
  }

  // -------------------------------------------------------------------------
  // Transport bar
  // -------------------------------------------------------------------------

  private buildTransport(
    audio: HTMLAudioElement,
    src: string,
    timestamps: TimestampEntry[],
    wrap: HTMLElement,
  ): HTMLElement {
    const transport = document.createElement('div')
    transport.className = 'directive-transport'
    // Stop transport clicks from bubbling to the wrap's cursor-move handler.
    transport.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    // -- Play/pause button --
    const playBtn = document.createElement('button')
    playBtn.className = 'directive-transport__play-btn'
    playBtn.setAttribute('aria-label', 'Play/pause')
    playBtn.textContent = audio.paused ? '▶' : '⏸'
    playBtn.addEventListener('click', () => {
      if (audio.paused) {
        audio.play().catch(err =>
          console.error('[obsidian-directives] audio play() failed:', err)
        )
      } else {
        audio.pause()
      }
    })

    // -- Scrubber --
    const scrubber = document.createElement('input')
    scrubber.type      = 'range'
    scrubber.className = 'directive-transport__scrubber'
    scrubber.min       = '0'
    scrubber.step      = '0.1'
    scrubber.max       = isFinite(audio.duration) ? String(audio.duration) : '100'
    scrubber.value     = String(audio.currentTime)
    scrubber.setAttribute('aria-label', 'Seek')

    // -- Time display --
    const timeDisplay = document.createElement('span')
    timeDisplay.className   = 'directive-transport__time'
    timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`

    // Scrubber interaction — stop propagation so the wrap doesn't move cursor.
    let scrubbing = false
    scrubber.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation()
      scrubbing = true
    })
    scrubber.addEventListener('mouseup', () => {
      scrubbing = false
      audio.currentTime = Number(scrubber.value)
      this.bus.publish('audio:seek', { src, time: audio.currentTime })
    })
    scrubber.addEventListener('input', () => {
      if (scrubbing) {
        timeDisplay.textContent =
          `${formatTime(Number(scrubber.value))} / ${formatTime(audio.duration)}`
      }
    })

    transport.appendChild(playBtn)
    transport.appendChild(scrubber)
    transport.appendChild(timeDisplay)

    // -- Wire audio events (attach to cached element; remove in destroy()) --
    const onPlay = (): void => {
      playBtn.textContent = '⏸'
      this.bus.publish('audio:play', { src, time: audio.currentTime })
    }
    const onPause = (): void => {
      playBtn.textContent = '▶'
      this.bus.publish('audio:pause', { src, time: audio.currentTime })
    }
    const onEnded = (): void => {
      playBtn.textContent = '▶'
    }
    const onLoadedMetadata = (): void => {
      scrubber.max        = String(audio.duration)
      timeDisplay.textContent = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`
    }

    audio.addEventListener('play',            onPlay)
    audio.addEventListener('pause',           onPause)
    audio.addEventListener('ended',           onEnded)
    audio.addEventListener('loadedmetadata',  onLoadedMetadata)

    this.cleanups.push(
      () => audio.removeEventListener('play',           onPlay),
      () => audio.removeEventListener('pause',          onPause),
      () => audio.removeEventListener('ended',          onEnded),
      () => audio.removeEventListener('loadedmetadata', onLoadedMetadata),
    )

    return transport
  }

  // -------------------------------------------------------------------------
  // Timestamp list
  // -------------------------------------------------------------------------

  private buildTimestampList(
    audio: HTMLAudioElement,
    src: string,
    timestamps: TimestampEntry[],
  ): HTMLElement {
    const list = document.createElement('div')
    list.className = 'directive-audio-timestamps'

    if (timestamps.length === 0) return list

    const rowEls: HTMLElement[] = []
    let activeIndex = getActiveIndex(audio.currentTime, timestamps)

    for (let i = 0; i < timestamps.length; i++) {
      const entry = timestamps[i]
      if (!entry) continue

      const row = document.createElement('div')
      row.className = 'directive-timestamp-row'
      if (i === activeIndex) row.classList.add('directive-row--active')

      const ts = document.createElement('span')
      ts.className   = 'directive-timestamp'
      ts.textContent = entry.raw

      const lbl = document.createElement('span')
      lbl.className   = 'directive-timestamp-label'
      lbl.textContent = entry.label

      row.appendChild(ts)
      row.appendChild(lbl)

      // Stop click from bubbling to wrap's cursor-move handler.
      row.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
      row.addEventListener('click', () => {
        audio.currentTime = entry.time
        this.bus.publish('audio:seek', { src, time: entry.time })
        if (audio.paused) {
          audio.play().catch(err =>
            console.error('[obsidian-directives] audio play() failed:', err)
          )
        }
      })

      rowEls.push(row)
      list.appendChild(row)
    }

    // Wire timeupdate — updates scrubber, time display, and active row.
    const onTimeUpdate = (): void => {
      const t = audio.currentTime

      // Update active row highlight.
      const newActive = getActiveIndex(t, timestamps)
      if (newActive !== activeIndex) {
        rowEls[activeIndex]?.classList.remove('directive-row--active')
        rowEls[newActive]?.classList.add('directive-row--active')
        activeIndex = newActive
      }

      this.bus.publish('audio:timeupdate', { src, time: t })
    }

    const onSeeked = (): void => {
      this.bus.publish('audio:seek', { src, time: audio.currentTime })
    }

    // Keep timeupdate separate from transport wiring so scrubber and
    // row highlighting update independently.
    const onTimeUpdateForScrubber = (): void => {
      const t = audio.currentTime
      // The scrubber lives in the transport element; find it in the DOM.
      const scrubberEl = list.previousElementSibling?.querySelector(
        '.directive-transport__scrubber'
      ) as HTMLInputElement | null
      const timeEl = list.previousElementSibling?.querySelector(
        '.directive-transport__time'
      ) as HTMLElement | null

      if (scrubberEl && !scrubberEl.matches(':active')) {
        scrubberEl.value = String(t)
      }
      if (timeEl) {
        timeEl.textContent = `${formatTime(t)} / ${formatTime(audio.duration)}`
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('timeupdate', onTimeUpdateForScrubber)
    audio.addEventListener('seeked',     onSeeked)

    this.cleanups.push(
      () => audio.removeEventListener('timeupdate', onTimeUpdate),
      () => audio.removeEventListener('timeupdate', onTimeUpdateForScrubber),
      () => audio.removeEventListener('seeked',     onSeeked),
    )

    return list
  }

  // -------------------------------------------------------------------------
  // Cleanup — called by CM6 when the widget's DOM is removed.
  // Deliberately does NOT pause audio; playback survives editing.
  // -------------------------------------------------------------------------

  destroy(_dom: HTMLElement): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the audio directive handler.
 * Call once in plugin onload() and register via plugin.addHandler().
 */
export function createAudioHandler(app: App): DirectiveHandler {
  return {
    name: 'audio',

    render(directive: ParsedDirective, state: EditorState): DirectiveWidget {
      const bus = state.field(eventBusField)
      return new AudioWidget(directive, bus, app)
    },
  }
}
