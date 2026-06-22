/**
 * settings.ts
 *
 * Persistent settings for Obsidian Directives, stored via Obsidian's
 * Plugin.loadData() / saveData() API.
 *
 * Handlers receive the live settings object so that attribute-level
 * overrides (e.g. {bpm=160}) still take precedence, but omitted
 * attributes fall back to whatever the user set here.
 */

export type ChordLayout = 'grid' | 'horizontal' | 'vertical' | 'text'

/** Whether log dates render as plain text or as Obsidian [[wikilinks]]. */
export type LogDateStyle = 'plain' | 'wikilink'

export interface DirectivesSettings {
  // ── Log handler ──────────────────────────────────────────────────────────
  /**
   * Controls how dates appear in :::log widgets.
   *   'plain'    — rendered as plain text: 2026-06-17
   *   'wikilink' — rendered as a wikilink using logDateFormat as the link target
   */
  logDateStyle: LogDateStyle
  /**
   * Heading level used for date entries in :::log blocks.
   *   0 — list item (- 2026-06-17), the original behaviour
   *   1–6 — Markdown heading (# … ######)
   * Headings appear in Obsidian's Outline panel; list items do not.
   */
  logDateHeadingLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6

  /**
   * Heading level for the "Log" title inserted at the top of the directive body.
   *   0 — no heading; the widget shows "Log" in its own header bar only
   *   1–6 — inserts a Markdown heading (# … ######) so it appears in the Outline
   */
  logTitleHeadingLevel: 0 | 1 | 2 | 3 | 4 | 5 | 6

  /**
   * Date format string used when logDateStyle is 'wikilink'.
   * The placeholder {{date}} is replaced with the YYYY-MM-DD value from the body.
   * Examples:
   *   "{{date}}"             → [[2026-06-17]]
   *   "Daily/{{date}}"       → [[Daily/2026-06-17]]
   *   "Journal/{{date}} Log" → [[Journal/2026-06-17 Log]]
   */
  logDateFormat: string

  /**
   * Show a button in the active view's header bar that opens the log popover.
   * Disabled by default — enable if you use the log popover frequently.
   */
  logViewButton: boolean

  // ── Tab handler ─────────────────────────────────────────────────────────
  /** Beats per minute when the bpm= attribute is absent. */
  defaultBpm: number
  /**
   * Characters per beat when the cpb= attribute is absent.
   * Tune this to your preferred tab notation density:
   *   1  — quarter-note dashes
   *   2  — eighth-note dashes  (most common)
   *   4  — sixteenth-note dashes
   */
  defaultCpb: number

  // ── Chords handler ───────────────────────────────────────────────────────
  /** Layout used when the layout= attribute is absent. */
  defaultChordLayout: ChordLayout

  // ── Fonts ─────────────────────────────────────────────────────────────────
  /** Custom font for :::log body lines. Empty = inherit Obsidian's text font. */
  fontLog: string
  /** Custom font for :::audio widgets. Empty = inherit. */
  fontAudio: string
  /** Custom font for :::chords widgets. Empty = inherit. */
  fontChords: string
  /** Custom font for :::tab widgets. Empty = inherit. */
  fontTab: string
  /** Custom font for :::youtube widgets. Empty = inherit. */
  fontYoutube: string

  // ── Internal ─────────────────────────────────────────────────────────────
  /** Incremented on breaking schema changes so old data can be migrated. */
  _version: number
}

export const DEFAULT_SETTINGS: DirectivesSettings = {
  logDateStyle:         'plain',
  logDateFormat:        '{{date}}',
  logDateHeadingLevel:  6,
  logTitleHeadingLevel: 2,
  logViewButton:        false,
  defaultBpm:         120,
  defaultCpb:         2,
  defaultChordLayout: 'grid',
  fontLog:     '',
  fontAudio:   '',
  fontChords:  '',
  fontTab:     '',
  fontYoutube: '',
  _version:           2,
}
