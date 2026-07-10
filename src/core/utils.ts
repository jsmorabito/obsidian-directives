/**
 * core/utils.ts
 *
 * Pure utility functions shared across handlers and UI.
 * No Obsidian or CodeMirror imports — safe to test in Node.
 */

import type { App } from 'obsidian'
import { TFile } from 'obsidian'
import type { DirectivesSettings } from '../settings'

// ---------------------------------------------------------------------------
// Date utilities (shared by log handler and add-to-log modal)
// ---------------------------------------------------------------------------

/**
 * Matches a log date line in either list-item or heading style,
 * with plain or wikilink dates.
 *
 * Capture groups:
 *   1 — date extracted from inside [[…]] (strips path prefix and suffix)
 *   2 — plain date (no wikilink)
 */
export const DATE_RE =
  /^(?:-|#{1,6})\s+(?:\[\[(?:[^\]|]*\/)?(\d{4}-\d{2}-\d{2})[^\]]*\]\]|(\d{4}-\d{2}-\d{2}))\s*$/

export function extractDate(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? ''
}

export function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function buildDateLine(dateISO: string, settings: DirectivesSettings): string {
  const prefix = settings.logDateHeadingLevel > 0
    ? '#'.repeat(settings.logDateHeadingLevel)
    : '-'

  if (settings.logDateStyle === 'wikilink') {
    const fmt = settings.logDateFormat || '{{date}}'
    const target = fmt.replace('{{date}}', dateISO)
    return `${prefix} [[${target}]]`
  }
  return `${prefix} ${dateISO}`
}

// ---------------------------------------------------------------------------
// Frontmatter filtering (shared by checklist and aggregator handlers)
// ---------------------------------------------------------------------------

export interface WhereCondition {
  key: string
  /** OR'd — file matches if frontmatter[key] matches any value */
  values: string[]
}

/**
 * Parse `where="key=val, key2=a|b"` into conditions.
 * Each comma-separated term is `key=value` or `key=a|b`.
 */
export function parseWhere(whereAttr: string): WhereCondition[] {
  if (!whereAttr.trim()) return []
  return whereAttr.split(',').flatMap(term => {
    const eq = term.indexOf('=')
    if (eq === -1) return []
    const key    = term.slice(0, eq).trim()
    const values = term.slice(eq + 1).split('|').map(v => v.trim().toLowerCase())
    return key ? [{ key, values }] : []
  })
}

/** Safely stringify a frontmatter value — only primitives produce meaningful strings. */
function fmStr(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v).toLowerCase()
  }
  return ''
}

export function matchesFrontmatter(
  frontmatter: Record<string, unknown> | null | undefined,
  conditions: WhereCondition[],
): boolean {
  if (!conditions.length) return true
  if (!frontmatter) return false
  return conditions.every(({ key, values }) => {
    const raw = frontmatter[key]
    if (raw == null) return false
    const candidates = Array.isArray(raw)
      ? raw.map(fmStr).filter(Boolean)
      : [fmStr(raw)].filter(Boolean)
    return values.some(v => candidates.includes(v))
  })
}

// ---------------------------------------------------------------------------
// File resolution (shared by checklist and aggregator handlers)
// ---------------------------------------------------------------------------

export function resolveFile(src: string, app: App): TFile | null {
  if (!src.trim()) return null
  const byPath = app.vault.getAbstractFileByPath(src.trim())
  if (byPath instanceof TFile) return byPath
  return app.metadataCache.getFirstLinkpathDest(src.trim(), '') ?? null
}

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  // Use window.* for popout-window compatibility in Obsidian; bare globals in Node tests.
  const scheduleTimeout: typeof setTimeout = typeof window !== 'undefined' ? window.setTimeout.bind(window) : setTimeout
  const cancelTimeout: typeof clearTimeout = typeof window !== 'undefined' ? window.clearTimeout.bind(window) : clearTimeout
  let timer: ReturnType<typeof setTimeout>
  return (...args: Parameters<T>): void => {
    cancelTimeout(timer)
    timer = scheduleTimeout(() => fn(...args), ms)
  }
}
