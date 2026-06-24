/**
 * handlers/youtube.ts
 *
 * Implements the :::youtube directive — a responsive embedded YouTube player
 * with an optional clickable timestamp list, auto-fetched transcript, and
 * event-bus integration.
 *
 * Syntax:
 *   :::youtube[Title]{vid="dQw4w9WgXcQ" start=45}
 *   [0:00] Introduction
 *   [0:45] Main concept
 *   [2:30] Wrap-up
 *   :::
 *
 *   :::youtube[Title]{vid="dQw4w9WgXcQ" transcript=auto}
 *   :::
 *
 * Attributes:
 *   vid         — YouTube video ID (11 chars) or any YouTube URL. Required.
 *   src         — Alias for vid.
 *   start       — Start time in seconds (default 0).
 *   transcript  — Set to "auto" to fetch and display the video transcript.
 *                 A "Save to note" button writes it into the directive body
 *                 as [m:ss] timestamp lines and removes this attribute.
 *
 * Event bus:
 *   Publishes:  youtube:timeupdate  { vid, time }  — polled every 250 ms while playing
 *               youtube:seek        { vid, time }  — on timestamp-row / transcript-line click
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

import { requestUrl } from 'obsidian'
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

/** Format seconds as [m:ss] — used when baking transcript back into the note. */
function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `[${m}:${s.toString().padStart(2, '0')}]`
}

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

function getActiveIndex(time: number, entries: { time: number }[]): number {
  let active = -1
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e !== undefined && e.time <= time) active = i
  }
  return active
}

// ---------------------------------------------------------------------------
// Transcript fetch
// ---------------------------------------------------------------------------

interface TranscriptLine {
  time: number  // seconds
  text: string
}

/**
 * Fetch captions using the same strategy as yt-dlp:
 *  1. Fetch the watch page to extract visitorData (required by ANDROID_VR).
 *  2. POST to /player with ANDROID_VR + visitorData — bypasses precondition checks.
 *  3. Fall back through ANDROID and WEB_EMBEDDED_PLAYER clients.
 *  4. For each client that returns tracks, try the signed baseUrl then simple
 *     timedtext fallback URLs in case the baseUrl returns empty.
 *
 * Returns [] when no captions are available.
 */
async function fetchTranscript(vid: string): Promise<TranscriptLine[]> {
  // Step 1 — extract visitorData from the watch page (required by ANDROID_VR)
  let visitorData: string | null = null
  try {
    const pageRes = await requestUrl({
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      throw: false,
    })
    if (pageRes.status < 400) {
      const m = /"VISITOR_DATA":\s*"([^"]+)"/.exec(pageRes.text)
      visitorData = m?.[1] ?? null
    }
  } catch { /* non-fatal — ANDROID_VR will just work without visitorData for some videos */ }

  // Step 2 — try InnerTube /player with each client in priority order
  const vd = visitorData ?? ''
  const clients = [
    // ANDROID_VR (Oculus Quest) — primary, same as yt-dlp. Works without po_token
    // when visitorData is supplied.
    {
      context: {
        client: {
          clientName: 'ANDROID_VR', clientVersion: '1.71.26',
          deviceMake: 'Oculus', deviceModel: 'Quest 3',
          androidSdkVersion: 32, osName: 'Android', osVersion: '12L',
          userAgent: 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          hl: 'en', gl: 'US',
          ...(vd ? { visitorData: vd } : {}),
        },
      },
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      extra: { 'X-YouTube-Client-Name': '28', 'X-YouTube-Client-Version': '1.71.26', 'Origin': 'https://www.youtube.com', ...(vd ? { 'X-Goog-Visitor-Id': vd } : {}) },
    },
    // ANDROID — fallback #1
    {
      context: { client: { clientName: 'ANDROID', clientVersion: '19.44.38', androidSdkVersion: 34, hl: 'en', gl: 'US' } },
      userAgent: 'com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip',
      extra: {} as Record<string, string>,
    },
    // WEB_EMBEDDED_PLAYER — fallback #2
    {
      context: {
        client: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '2.20231121.08.00', hl: 'en', gl: 'US' },
        thirdParty: { embedUrl: 'https://www.youtube.com/' },
      },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      extra: {} as Record<string, string>,
    },
  ]

  const captionHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer':         `https://www.youtube.com/watch?v=${vid}`,
    'Accept':          'text/xml,application/xml,*/*;q=0.8',
  }

  for (const client of clients) {
    try {
      const res = await requestUrl({
        url:    'https://www.youtube.com/youtubei/v1/player',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent, ...client.extra },
        body:   JSON.stringify({ context: client.context, videoId: vid }),
        throw:  false,
      })
      if (res.status >= 400) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = res.json
      const tracks: Array<{ baseUrl?: string; languageCode?: string; kind?: string }> =
        data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
      if (tracks.length === 0) continue

      const pick =
        tracks.find(t => t.languageCode === 'en' && t.kind === 'asr') ??
        tracks.find(t => t.languageCode === 'en') ??
        tracks[0]!

      const lang  = pick.languageCode ?? 'en'
      const isAsr = pick.kind === 'asr' || (pick.baseUrl ?? '').includes('kind=asr') || (pick.baseUrl ?? '').includes('caps=asr')

      // Try the signed baseUrl first, then simpler timedtext fallback URLs
      const urls = [
        pick.baseUrl ?? '',
        ...(isAsr ? [`https://www.youtube.com/api/timedtext?v=${vid}&lang=${lang}&caps=asr&fmt=xml3`] : []),
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=${lang}&fmt=xml3`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=${lang}&fmt=srv3`,
        `https://www.youtube.com/api/timedtext?v=${vid}&lang=${lang}`,
      ].filter(Boolean)

      for (const url of urls) {
        try {
          const cr = await requestUrl({ url, headers: captionHeaders, throw: false })
          if (cr.status >= 400 || !cr.text?.trim()) continue
          const lines = parseTimedTextXml(cr.text)
          if (lines.length > 0) return lines
        } catch { /* try next url */ }
      }
    } catch { /* try next client */ }
  }

  return []
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g,       (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([a-fA-F0-9]+);/g, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/\n/g, ' ')
    .trim()
}

function parseTimedTextXml(text: string): TranscriptLine[] {
  // JSON3 / xml3: { events: [{ tStartMs, segs: [{utf8}] }] }
  if (text.trimStart().startsWith('{')) {
    try {
      const data = JSON.parse(text) as { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }
      const lines: TranscriptLine[] = []
      for (const ev of data.events ?? []) {
        if (ev.tStartMs === undefined) continue
        const t = (ev.segs ?? []).map(s => s.utf8 ?? '').join('').replace(/\n/g, ' ').trim()
        if (t) lines.push({ time: Math.floor(ev.tStartMs / 1000), text: t })
      }
      return lines
    } catch { return [] }
  }

  // srv3 / ANDROID_VR format: <p t="ms" d="ms">…</p>
  // (t = start ms, d = duration ms, may contain inner <s> tags)
  const pPattern = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g
  const pLines: TranscriptLine[] = []
  for (const m of text.matchAll(pPattern)) {
    const clean = decodeXmlEntities(m[3]!.replace(/<[^>]+>/g, ''))
    if (clean) pLines.push({ time: Math.floor(parseInt(m[1]!, 10) / 1000), text: clean })
  }
  if (pLines.length > 0) return pLines

  // srv1 / legacy XML: <text start="s" dur="s">…</text>
  const tPattern = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g
  const tLines: TranscriptLine[] = []
  for (const m of text.matchAll(tPattern)) {
    const start = parseFloat(m[1]!)
    if (isNaN(start)) continue
    const clean = decodeXmlEntities(m[3]!.replace(/<[^>]+>/g, ''))
    if (clean) tLines.push({ time: Math.floor(start), text: clean })
  }
  return tLines
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
      this.directive.attributes['vid']        === other.directive.attributes['vid']        &&
      this.directive.attributes['src']        === other.directive.attributes['src']        &&
      this.directive.attributes['start']      === other.directive.attributes['start']      &&
      this.directive.attributes['transcript'] === other.directive.attributes['transcript'] &&
      this.directive.body                     === other.directive.body                     &&
      this.directive.label                    === other.directive.label
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

    const transcriptMode = (this.directive.attributes['transcript'] ?? '').toLowerCase() === 'auto'

    if (transcriptMode) {
      // Auto-fetch transcript — body-based timestamps are ignored in this mode
      const panel = this.buildTranscriptLoadingPanel()
      wrap.appendChild(panel)
      fetchTranscript(vid).then(lines => {
        const filled = this.buildTranscriptPanel(lines, vid, iframe, view)
        panel.replaceWith(filled)
      }).catch((err: unknown) => {
        panel.replaceWith(this.buildTranscriptError(err))
      })
    } else if (timestamps.length > 0) {
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

  // ── Transcript panel ───────────────────────────────────────────────────

  private buildTranscriptLoadingPanel(): HTMLElement {
    const panel = activeDocument.createElement('div')
    panel.className = 'directive-youtube-transcript directive-youtube-transcript--loading'
    const msg = activeDocument.createElement('span')
    msg.className   = 'directive-transcript-loading-msg'
    msg.textContent = 'Loading transcript…'
    panel.appendChild(msg)
    return panel
  }

  private buildTranscriptError(err: unknown): HTMLElement {
    const panel = activeDocument.createElement('div')
    panel.className = 'directive-youtube-transcript directive-youtube-transcript--error'
    const icon = activeDocument.createElement('span')
    icon.textContent = '⚠'
    const msg = activeDocument.createElement('span')
    const detail = err instanceof Error ? err.message : String(err)
    msg.textContent = `Could not load transcript: ${detail}`
    panel.appendChild(icon)
    panel.appendChild(msg)
    return panel
  }

  private buildTranscriptPanel(
    lines: TranscriptLine[],
    vid: string,
    iframe: HTMLIFrameElement,
    view: EditorView,
  ): HTMLElement {
    const panel = activeDocument.createElement('div')
    panel.className = 'directive-youtube-transcript'

    // Header with "Save to note" button
    const header = activeDocument.createElement('div')
    header.className = 'directive-transcript-header'

    const label = activeDocument.createElement('span')
    label.className   = 'directive-transcript-label'
    label.textContent = 'Transcript'

    const saveBtn = activeDocument.createElement('button')
    saveBtn.className   = 'directive-transcript-save-btn'
    saveBtn.textContent = 'Save to note'
    saveBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    saveBtn.addEventListener('click', () => {
      this.bakeTranscript(view, lines)
    })

    header.appendChild(label)
    header.appendChild(saveBtn)
    panel.appendChild(header)

    if (lines.length === 0) {
      const empty = activeDocument.createElement('div')
      empty.className   = 'directive-transcript-empty'
      empty.textContent = 'No transcript available for this video.'
      panel.appendChild(empty)
      return panel
    }

    // Scrollable line list
    const list = activeDocument.createElement('div')
    list.className = 'directive-transcript-list'

    const rowEls: HTMLElement[] = []
    let activeIndex = -1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue

      const row = activeDocument.createElement('div')
      row.className = 'directive-timestamp-row directive-transcript-row'

      const ts = activeDocument.createElement('span')
      ts.className   = 'directive-timestamp'
      ts.textContent = formatTimestamp(line.time)

      const txt = activeDocument.createElement('span')
      txt.className   = 'directive-timestamp-label'
      txt.textContent = line.text

      row.appendChild(ts)
      row.appendChild(txt)

      row.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
      row.addEventListener('click', () => {
        this.seekPlayer(iframe, line.time)
        this.bus.publish('youtube:seek', { vid, time: line.time })
      })

      rowEls.push(row)
      list.appendChild(row)
    }

    const unsubTime = this.bus.subscribe('youtube:timeupdate', ({ vid: evVid, time }) => {
      if (evVid !== vid) return
      const newActive = getActiveIndex(time, lines)
      if (newActive === activeIndex) return
      rowEls[activeIndex]?.classList.remove('directive-row--active')
      const nextRow = rowEls[newActive]
      if (nextRow) {
        nextRow.classList.add('directive-row--active')
        nextRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      activeIndex = newActive
    })
    this.cleanups.push(unsubTime)

    panel.appendChild(list)
    return panel
  }

  /**
   * Write the fetched transcript back into the directive source as [m:ss] lines,
   * and remove the `transcript=auto` attribute, converting it to a static list.
   */
  private bakeTranscript(view: EditorView, lines: TranscriptLine[]): void {
    const raw   = view.state.doc.sliceString(this.directive.from, this.directive.to)
    const parts = raw.split('\n')
    const first = parts[0] ?? ''
    const last  = parts[parts.length - 1] ?? ':::'

    // Strip transcript=auto (with or without quotes, leading space)
    const newFirst = first.replace(/\s*transcript=(?:"auto"|auto)/, '')
    const bodyLines = lines.map(l => `${formatTimestamp(l.time)} ${l.text}`)
    const newSource = [newFirst, ...bodyLines, last].join('\n')

    view.dispatch({
      changes: { from: this.directive.from, to: this.directive.to, insert: newSource },
    })
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
    // Use the window that owns the iframe's document, not the global window —
    // in Obsidian's multi-window setup these may differ.
    const win = iframe.ownerDocument.defaultView ?? window
    let pollId: number | null = null

    const sendCmd = (func: string, args: unknown = []): void => {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'command', func, args }),
        '*',
      )
    }

    const sendListening = (): void => {
      iframe.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening' }),
        '*',
      )
    }

    const startPolling = (): void => {
      if (pollId !== null) return
      pollId = win.setInterval(() => sendCmd('getCurrentTime'), 250)
    }

    const stopPolling = (): void => {
      if (pollId !== null) { win.clearInterval(pollId); pollId = null }
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

      if (data['event'] === 'onReady') {
        sendListening()
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

    // Send listening handshake once iframe is loaded so YouTube starts sending events
    iframe.addEventListener('load', () => sendListening())

    win.addEventListener('message', onMessage)

    // Respond to seek events from other widgets (e.g. a linked chords block)
    const unsubSeek = this.bus.subscribe('youtube:seek', ({ vid: seekVid, time }) => {
      if (seekVid !== vid) return
      this.seekPlayer(iframe, time)
    })

    this.cleanups.push(
      () => win.removeEventListener('message', onMessage),
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
