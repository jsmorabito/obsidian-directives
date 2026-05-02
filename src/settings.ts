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

export interface DirectivesSettings {
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

  // ── Internal ─────────────────────────────────────────────────────────────
  /** Incremented on breaking schema changes so old data can be migrated. */
  _version: number
}

export const DEFAULT_SETTINGS: DirectivesSettings = {
  defaultBpm:         120,
  defaultCpb:         2,
  defaultChordLayout: 'grid',
  _version:           2,
}
