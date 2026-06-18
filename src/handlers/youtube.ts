/**
 * handlers/youtube.ts
 *
 * Implements the :::youtube directive — a responsive embedded YouTube player
 * with an optional clickable timestamp list and event-bus integration.
 *
 * Syntax:
 *   :::youtube[Title]{vid="dQw4w9WgXcQ" start=45}
 *   [0:00] Introduction
 *   [0:45] Main concept
 *   [2:30] Wrap-up
 *   :::
 *
 * Attributes:
 *   vid    — YouTube video ID (11 chars) or any YouTube URL. Required.
 *   src    — Alias for vid.
 *   start  — Start time in seconds (default 0).
 *
 * Event bus:
 *   Publishes:  youtube:timeupdate  { vid, time }  — polled every 250 ms while playing
 *               youtube:seek        { vid, time }  — on timestamp-row click
 *   Subscribes: youtube:seek        { vid, time }  — seeks the embedded player
 *
 * Time tracking strategy:
 *   YouTube's IFrame API communicates via window.postMessage.  We embed the
 *   iframe with ?enablejsapi=1 and listen for onStateChange messages.  When
 *   the player is playing (state 1) we poll getCurrentTime every 250 ms via
 *   postMessage and publish the result as youtube:timeupdate.  On youtube:seek
 *   we send a seekTo command back to the iframe.
 *
 * Spec: §4.4 and §9.4
 */

import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { eventBusField } from '../core/event-bus'
import type { EventBus } from '../core/event-bus'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an 11-char YouTube video ID from:
 *   - A bare 11-char ID:          "dQw4w9WgXcQ"
 *   - A watch URL:                "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
 *   - A short URL:                "https://youtu.be/dQw4w9WgXcQ"
 *   - An embed URL:               "https://www.youtube.com/embed/dQw4w9WgXcQ"
 */
function parseVideoId(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^[\w-]{11}$/.test(s)) return s
  const m = /(?:v=|\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{11})/.exec(s)
  return m ? (m[1] ?? null) : null
}

interface TimestampEntry {
  time: number
  label: string
  raw: string   // "[m:ss]"
}

const TS_RE = /^\[(\d+):(\d{2})\]\s*(.*)/

function parseTimestamps(body: string): TimestampEntry[] {
  const entries: TimestampEntry[] = []
  for (const line of body.split('\n')) {
    const m = TS_RE.exec(line.trim())
    if (!m) continue
    const min = parseInt(m[1] ?? '0', 10)
    const sec = parseInt(m[2] ?? '0', 10)
    entries.push({
      time:  min * 60 + sec,
      label: m[3] ?? '',
      raw:   `[${m[1]}:${m[2]}]`,
    })
  }
  return entries
}

function getActiveIndex(time: number, entries: TimestampEntry[]): number {
  let active = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e !== undefined && e.time <= time) active = i
  }
  return active
}

// ---------------------------------------------------------------------------
// YouTubeWidget
// ---------------------------------------------------------------------------

class YouTubeWidget extends DirectiveWidget {
  private cleanups: Array<() => void> = []

  constructor(
    private readonly directive: ParsedDirective,
    private readonly bus: EventBus,
  ) {
    super()
  }

  eq(other: YouTubeWidget): boolean {
    if (!(other instanceof YouTubeWidget)) return false
    return (
      this.directive.attributes['vid']   === other.directive.attributes['vid']   &&
      this.directive.attributes['src']   === other.directive.attributes['src']   &&
      this.directive.attributes['start'] === other.directive.attributes['start'] &&
      this.directive.body                === other.directive.body                &&
      this.directive.label               === other.directive.label
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const vidAttr    = this.directive.attributes['vid'] ?? this.directive.attributes['src'] ?? ''
    const vid        = parseVideoId(vidAttr)
    const start      = parseInt(this.directive.attributes['start'] ?? '0', 10) || 0
    const timestamps = parseTimestamps(this.directive.body ?? '')

    const wrap = activeDocument.createElement('div')
    wrap.className = 'directive-widget directive-widget--youtube'

    // Required: click-to-edit
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    // Error state — video ID missing or unparseable
    if (!vid) {
      wrap.classList.add('directive-widget--youtube-error')
      wrap.appendChild(this.buildError(vidAttr))
      return wrap
    }

    // Optional header label
    if (this.directive.label) {
      const header = activeDocument.createElement('div')
      header.className   = 'directive-youtube-header'
      header.textContent = this.directive.label
      wrap.appendChild(header)
    }

    // 16:9 responsive iframe wrapper
    const iframe = this.buildIframe(vid, start)
    const embedWrap = activeDocument.createElement('div')
    embedWrap.className = 'directive-youtube-embed'
    embedWrap.appendChild(iframe)
    // Stop iframe interactions from bubbling to the cursor-move handler.
    embedWrap.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    wrap.appendChild(embedWrap)

    // Timestamp list
    if (timestamps.length > 0) {
      wrap.appendChild(this.buildTimestampList(timestamps, vid, iframe))
    }

    // Wire postMessage ↔ event bus
    this.wirePostMessage(vid, iframe)

    return wrap
  }

  // ── iframe ─────────────────────────────────────────────────────────────

  private buildIframe(vid: string, start: number): HTMLIFrameElement {
    const params = new URLSearchParams({
      enablejsapi:     '1',
      rel:             '0',   // suppress related-videos panel
      modestbranding:  '1',
    })
    if (start > 0) params.set('start', String(start))

    const iframe           = activeDocument.createElement('iframe')
    iframe.src             = `https://www.youtube.com/embed/${vid}?${params}`
    iframe.className       = 'directive-youtube-iframe'
    iframe.allow           = [
      'accelerometer',
      'autoplay',
      'clipboard-write',
      'encrypted-media',
      'gyroscope',
      'picture-in-picture',
    ].join('; ')
    iframe.allowFullscreen = true
    return iframe
  }

  // ── Timestamp list ─────────────────────────────────────────────────────

  private buildTimestampList(
    timestamps: TimestampEntry[],
    vid: string,
    iframe: HTMLIFrameElement,
  ): HTMLElement {
    const list = activeDocument.createElement('div')
    list.className = 'directive-youtube-timestamps'

    const rowEls: HTMLElement[] = []
    let activeIndex = -1

    for (let i = 0; i < timestamps.length; i++) {
      const entry = timestamps[i]
      if (!entry) continue

      const row = activeDocument.createElement('div')
      row.className = 'directive-timestamp-row'

      const tsEl = activeDocument.createElement('span')
      tsEl.className   = 'directive-timestamp'
      tsEl.textContent = entry.raw

      const lblEl = activeDocument.createElement('span')
      lblEl.className   = 'directive-timestamp-label'
      lblEl.textContent = entry.label

      row.appendChild(tsEl)
      row.appendChild(lblEl)

      row.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
      row.addEventListener('click', () => {
        this.seekPlayer(iframe, entry.time)
        this.bus.publish('youtube:seek', { vid, time: entry.time })
      })

      rowEls.push(row)
      list.appendChild(row)
    }

    // Highlight active row as the video plays
    const unsubTime = this.bus.subscribe('youtube:timeupdate', ({ vid: evVid, time }) => {
      if (evVid !== vid) return
      const newActive = getActiveIndex(time, timestamps)
      if (newActive === activeIndex) return
      rowEls[activeIndex]?.classList.remove('directive-row--active')
      rowEls[newActive]?.classList.add('directive-row--active')
      activeIndex = newActive
    })
    this.cleanups.push(unsubTime)

    return list
  }

  // ── postMessage ↔ event bus ────────────────────────────────────────────

  private wirePostMessage(vid: string, iframe: HTMLIFrameElement): void {
    let pollId: number | null = null

    const send = (func: string, args: unknown = ''): void => {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func, args }),
        '*',
      )
    }

    const startPolling = (): void => {
      if (pollId !== null) return
      pollId = window.setInterval(() => send('getCurrentTime'), 250)
    }

    const stopPolling = (): void => {
      if (pollId !== null) { window.clearInterval(pollId); pollId = null }
    }

    const onMessage = (e: MessageEvent): void => {
      // Only handle messages from this specific iframe
      if (e.source !== iframe.contentWindow) return

      let data: Record<string, unknown>
      try {
        data = JSON.parse(typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) as Record<string, unknown>
      } catch {
        return
      }

      // YouTube player state: 1=playing, 2=paused, 0=ended, 3=buffering
      if (data['event'] === 'onStateChange') {
        const state = data['info'] as number
        if (state === 1) startPolling(); else stopPolling()
      }

      // Response to getCurrentTime command
      if (data['event'] === 'infoDelivery') {
        const info = data['info'] as Record<string, unknown> | null
        const time = info?.['currentTime']
        if (typeof time === 'number') {
          this.bus.publish('youtube:timeupdate', { vid, time })
        }
      }
    }

    window.addEventListener('message', onMessage)

    // Respond to seek events from other widgets (e.g. a linked chords block)
    const unsubSeek = this.bus.subscribe('youtube:seek', ({ vid: seekVid, time }) => {
      if (seekVid !== vid) return
      this.seekPlayer(iframe, time)
    })

    this.cleanups.push(
      () => window.removeEventListener('message', onMessage),
      () => stopPolling(),
      unsubSeek,
    )
  }

  private seekPlayer(iframe: HTMLIFrameElement, time: number): void {
    iframe.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func: 'seekTo', args: [time, true] }),
      '*',
    )
  }

  // ── Error state ────────────────────────────────────────────────────────

  private buildError(raw: string): HTMLElement {
    const row = activeDocument.createElement('div')
    row.className = 'directive-widget--error'

    const icon = activeDocument.createElement('span')
    icon.className   = 'directive-error-icon'
    icon.textContent = '⚠'

    const msg = activeDocument.createElement('span')
    msg.className   = 'directive-error-msg'
    msg.textContent = raw.trim()
      ? `Could not parse YouTube video ID: "${raw}"`
      : 'Missing vid attribute'

    row.appendChild(icon)
    row.appendChild(msg)
    return row
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  destroy(_dom: HTMLElement): void {
    for (const cleanup of this.cleanups) cleanup()
    this.cleanups = []
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the YouTube directive handler.
 * Call once in plugin onload() and register via plugin.addHandler().
 */
export function createYouTubeHandler(): DirectiveHandler {
  return {
    name: 'youtube',

    render(directive: ParsedDirective, state: EditorState): DirectiveWidget {
      const bus = state.field(eventBusField)
      return new YouTubeWidget(directive, bus)
    },
  }
}
