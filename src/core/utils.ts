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
 * with plain or wikilink dates. Tolerates leading indentation so day
 * entries nested under a month group (list mode) still match.
 *
 * Capture groups:
 *   1 — date extracted from inside [[…]] (strips path prefix and suffix)
 *   2 — plain date (no wikilink)
 */
export const DATE_RE =
  /^[ \t]*(?:-|#{1,6})\s+(?:\[\[(?:[^\]|]*\/)?(\d{4}-\d{2}-\d{2})[^\]]*\]\]|(\d{4}-\d{2}-\d{2}))\s*$/

/**
 * Matches a log month-group line — same shape as DATE_RE but a bare
 * YYYY-MM (no day, no wikilink support). Used to group day entries under
 * a shared month header via the "Clean up log" command.
 */
export const MONTH_RE = /^[ \t]*(?:-|#{1,6})\s+(\d{4}-\d{2})\s*$/

export function extractDate(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? ''
}

export function extractMonth(match: RegExpExecArray): string {
  return match[1] ?? ''
}

/** YYYY-MM slice of a YYYY-MM-DD date string. */
export function monthOf(dateISO: string): string {
  return dateISO.slice(0, 7)
}

/** One level of list-item indentation used when nesting day entries under a month group. */
export const INDENT_UNIT = '    '

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

/**
 * Resolves the heading level month-group lines should use, honoring
 * logMonthHeadingLevel when set, otherwise falling back to one level
 * shallower than logDateHeadingLevel. Returns:
 *   0    — list mode (months are always a plain "- " bullet)
 *   1-6  — a valid, strictly-shallower heading level for months
 *   null — heading mode with no valid level available (must be < day level)
 */
export function resolveMonthHeadingLevel(settings: DirectivesSettings): number | null {
  if (settings.logDateHeadingLevel === 0) return 0
  const level = settings.logMonthHeadingLevel > 0
    ? settings.logMonthHeadingLevel
    : settings.logDateHeadingLevel - 1
  if (level < 1 || level >= settings.logDateHeadingLevel) return null
  return level
}

/**
 * Builds a month-group line (e.g. "- 2026-07" or "##### 2026-07") at the
 * level resolveMonthHeadingLevel() picks, so native Obsidian folding treats
 * it as the days' parent. Throws if no valid level is available — callers
 * must guard with resolveMonthHeadingLevel() first.
 */
export function buildMonthLine(monthStr: string, settings: DirectivesSettings): string {
  const level = resolveMonthHeadingLevel(settings)
  if (level === null) {
    throw new Error(
      'No valid month heading level available — check the Month heading level setting.',
    )
  }
  return level === 0 ? `- ${monthStr}` : `${'#'.repeat(level)} ${monthStr}`
}

/**
 * Detects a leading title line (e.g. "## Log") at the top of a log body so
 * scanning logic can skip over it. Must exclude MONTH_RE too, or a grouped
 * heading-mode log's first month header (starts with "#", not a date) would
 * be misdetected as the title and dropped from scanning.
 */
export function splitLogTitle(bodyLines: string[]): { scanFrom: number; titleOffset: number } {
  const firstLine = bodyLines[0]?.trimEnd() ?? ''
  const isTitle = firstLine.startsWith('#') && !DATE_RE.exec(firstLine) && !MONTH_RE.exec(firstLine)
  return isTitle
    ? { scanFrom: 1, titleOffset: firstLine.length + 1 }
    : { scanFrom: 0, titleOffset: 0 }
}

/** True if the body has at least one top-level (unindented) month-group line. */
export function isGroupedBody(body: string): boolean {
  return body.split('\n').some(line => !/^[ \t]/.test(line) && MONTH_RE.test(line.trimEnd()))
}

// ---------------------------------------------------------------------------
// locateLogInsertion — shared scan used by insertNewEntry (log.ts) and
// insertNoteIntoLog (add-to-log-modal.ts) to find where a date entry
// belongs, whether the body is flat or grouped by month.
// ---------------------------------------------------------------------------

export type LogInsertionPoint =
  | {
      found: true
      /** Absolute offset of the start of the matched date line. */
      dateLineStart: number
      /** Length of the matched date line (excl. trailing \n). */
      dateLineLength: number
      /** Raw text of the line immediately after the date line. */
      nextLineText: string
      /** Offset marking the end of this entry's content block. */
      entryEnd: number
      /** Indentation the matched date line already has: '' or INDENT_UNIT. */
      dateIndent: string
      /** Prefix for a new content/sub-item line under this date. */
      contentPrefix: string
      needsMonthLine: false
    }
  | {
      found: false
      /** Offset to splice a new entry at (trailing blank lines skipped). */
      insertAt: number
      /** Raw scan end reached, for trimming blank lines up to insertAt. */
      scanEnd: number
      /** Indentation to prepend to the new date line: '' or INDENT_UNIT. */
      dateIndent: string
      /** Prefix for the new content/sub-item line under this date. */
      contentPrefix: string
      /** Whether a new month header line must be created too. */
      needsMonthLine: boolean
      monthStr?: string
    }

/** Leading whitespace length of `entryIndent` must match exactly — deeper-indented
 *  content lines that happen to look date-shaped must never be mistaken for entries. */
function matchAtIndent(line: string, entryIndent: string, re: RegExp): RegExpExecArray | null {
  if (!line.startsWith(entryIndent)) return null
  const rest = line.slice(entryIndent.length)
  if (/^[ \t]/.test(rest)) return null
  return re.exec(line.trimEnd())
}

function scanForDate(
  bodyLines: string[],
  startLine: number,
  endLine: number,
  startOffset: number,
  dateISO: string,
  entryIndent: string,
): { found: true; dateLineStart: number; dateLineLength: number; nextLineText: string; entryEnd: number }
 | { found: false; insertAt: number; scanEnd: number } {
  let charCount = startOffset
  let insertAt = startOffset

  for (let i = startLine; i < endLine; i++) {
    const line = bodyLines[i] ?? ''
    const match = matchAtIndent(line, entryIndent, DATE_RE)

    if (match) {
      const existingDate = extractDate(match)

      if (existingDate === dateISO) {
        let entryEnd = charCount + line.length + 1
        let innerCount = entryEnd
        for (let j = i + 1; j < endLine; j++) {
          const innerLine = bodyLines[j] ?? ''
          if (matchAtIndent(innerLine, entryIndent, DATE_RE) || matchAtIndent(innerLine, entryIndent, MONTH_RE)) break
          innerCount += innerLine.length + 1
          if (innerLine.trim()) entryEnd = innerCount
        }
        return {
          found: true,
          dateLineStart: charCount,
          dateLineLength: line.length,
          nextLineText: bodyLines[i + 1] ?? '',
          entryEnd,
        }
      }

      if (dateISO > existingDate) {
        return { found: false, insertAt, scanEnd: charCount }
      }
    }

    charCount += line.length + 1
    if (line.trim()) insertAt = charCount
  }

  return { found: false, insertAt, scanEnd: charCount }
}

function scanMonths(
  bodyLines: string[],
  startLine: number,
  startOffset: number,
  targetMonth: string,
): { kind: 'found'; startLine: number; endLine: number; startOffset: number } | { kind: 'insert'; offset: number } {
  let charCount = startOffset
  let insertAt = startOffset
  let i = startLine

  while (i < bodyLines.length) {
    const line = bodyLines[i] ?? ''
    const trimmed = line.trimEnd()
    const topLevel = !/^[ \t]/.test(line)

    if (topLevel && MONTH_RE.test(trimmed)) {
      const monthMatch = MONTH_RE.exec(trimmed)!
      const monthStr = extractMonth(monthMatch)
      const groupStart = charCount
      let innerCount = charCount + line.length + 1
      let groupEnd = innerCount
      let j = i + 1
      for (; j < bodyLines.length; j++) {
        const innerLine = bodyLines[j] ?? ''
        if (!/^[ \t]/.test(innerLine)) {
          const innerTrimmed = innerLine.trimEnd()
          if (MONTH_RE.test(innerTrimmed) || DATE_RE.test(innerTrimmed)) break
        }
        innerCount += innerLine.length + 1
        if (innerLine.trim()) groupEnd = innerCount
      }

      if (monthStr === targetMonth) {
        return { kind: 'found', startLine: i + 1, endLine: j, startOffset: charCount + line.length + 1 }
      }
      if (targetMonth > monthStr) {
        return { kind: 'insert', offset: groupStart }
      }

      charCount = innerCount
      insertAt = groupEnd
      i = j
      continue
    }

    // Stray top-level date line not wrapped in a month group (hand-edited
    // mixed state) — treat as a boundary only, never merge into it.
    charCount += line.length + 1
    if (line.trim()) insertAt = charCount
    i++
  }

  return { kind: 'insert', offset: insertAt }
}

export function locateLogInsertion(
  body: string,
  dateISO: string,
  settings: DirectivesSettings,
): LogInsertionPoint {
  const bodyLines = body.split('\n')
  const { scanFrom, titleOffset } = splitLogTitle(bodyLines)
  const flatContentPrefix = settings.logDateHeadingLevel > 0 ? '- ' : INDENT_UNIT + '- '

  if (!isGroupedBody(body)) {
    const result = scanForDate(bodyLines, scanFrom, bodyLines.length, titleOffset, dateISO, '')
    return { ...result, dateIndent: '', contentPrefix: flatContentPrefix, needsMonthLine: false }
  }

  const targetMonth = monthOf(dateISO)
  const groupedDateIndent = settings.logDateHeadingLevel > 0 ? '' : INDENT_UNIT
  const groupedContentPrefix = settings.logDateHeadingLevel > 0
    ? '- '
    : INDENT_UNIT + INDENT_UNIT + '- '

  const monthScan = scanMonths(bodyLines, scanFrom, titleOffset, targetMonth)

  if (monthScan.kind === 'found') {
    const dayResult = scanForDate(
      bodyLines, monthScan.startLine, monthScan.endLine, monthScan.startOffset, dateISO, groupedDateIndent,
    )
    return { ...dayResult, dateIndent: groupedDateIndent, contentPrefix: groupedContentPrefix, needsMonthLine: false }
  }

  return {
    found: false,
    insertAt: monthScan.offset,
    scanEnd: monthScan.offset,
    dateIndent: groupedDateIndent,
    contentPrefix: groupedContentPrefix,
    needsMonthLine: true,
    monthStr: targetMonth,
  }
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
