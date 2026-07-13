/**
 * handlers/log.ts
 *
 * Implements the :::log directive — a chronological activity log rendered
 * in-place (decorateInPlace: true). The raw Markdown is always visible and
 * editable. A small action widget is placed at the end of the opening fence
 * line for "New entry" / date-picker buttons.
 */

import { Notice, setIcon } from 'obsidian'
import { EditorView, WidgetType } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { foldEffect, unfoldEffect, foldedRanges, foldService } from '@codemirror/language'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import type { DirectivesSettings } from '../settings'
import {
  DATE_RE, MONTH_RE, extractDate, monthOf, todayISO, buildDateLine, buildMonthLine,
  splitLogTitle, isGroupedBody, locateLogInsertion, resolveMonthHeadingLevel, INDENT_UNIT,
} from '../core/utils'

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

export interface LogEntry {
  date: string
  dateOffset: number
  lines: string[]
  lineOffsets: number[]
}

export function parseLogBody(body: string): LogEntry[] {
  const entries: LogEntry[] = []
  let current: LogEntry | null = null
  let currentIndent = 0
  let offset = 0

  for (const raw of body.split('\n')) {
    const trimmed = raw.trimEnd()
    if (MONTH_RE.exec(trimmed)) {
      // Month-group line — structural, not an entry. Doesn't close the
      // current entry (that already ended when a boundary DATE_RE line
      // was hit, or a month line only appears between entries anyway).
      offset += raw.length + 1
      continue
    }
    const dateMatch = DATE_RE.exec(trimmed)
    if (dateMatch) {
      currentIndent = raw.length - raw.trimStart().length
      current = { date: extractDate(dateMatch), dateOffset: offset, lines: [], lineOffsets: [] }
      entries.push(current)
    } else if (current && raw.trim()) {
      current.lineOffsets.push(offset)
      const relative = raw.slice(currentIndent)
      const stripped = relative.replace(/^(\t|  {1,4})/, '')
      current.lines.push(stripped)
    }
    offset += raw.length + 1
  }

  return entries
}

// ---------------------------------------------------------------------------
// groupLogByMonth — powers the "Clean up log" command
// ---------------------------------------------------------------------------

/**
 * Returns the raw text of the first non-blank line that isn't a month line,
 * a date line, or content under an open date entry — i.e. content that
 * "Clean up log" can't safely place — or null if the body is entirely
 * well-formed.
 */
function findUngroupableLine(bodyLines: string[]): string | null {
  let insideEntry = false
  for (const raw of bodyLines) {
    if (!raw.trim()) continue
    const trimmed = raw.trimEnd()
    const topLevel = !/^[ \t]/.test(raw)
    if (topLevel && MONTH_RE.test(trimmed)) { insideEntry = false; continue }
    if (DATE_RE.test(trimmed)) { insideEntry = true; continue }
    if (insideEntry) continue
    return raw
  }
  return null
}

/**
 * Reorganizes a :::log body so every day entry becomes a child of its
 * month (e.g. "2026-07"), grouping the flat, newest-first list the widget
 * normally produces into fold-able month sections. Manual, idempotent —
 * running it again on an already-grouped body reproduces the same output.
 * Never drops content: any line it can't place aborts the whole operation.
 */
export function groupLogByMonth(
  body: string,
  settings: DirectivesSettings,
): { ok: true; body: string } | { ok: false; reason: string } {
  if (resolveMonthHeadingLevel(settings) === null) {
    return {
      ok: false,
      reason: settings.logMonthHeadingLevel > 0
        ? 'Month grouping needs the Month heading level to be shallower than the Date heading level '
          + '— fix it in Settings → Directives.'
        : 'Month grouping needs the log date heading level to be 0 (list) or 2 or higher — '
          + 'level 1 has no shallower heading level for month headers. Change it in Settings → Directives.',
    }
  }

  const bodyLines = body.split('\n')
  const { scanFrom, titleOffset } = splitLogTitle(bodyLines)
  const titleLine = scanFrom === 1 ? (bodyLines[0] ?? '') : null
  const restLines = bodyLines.slice(scanFrom)

  const badLine = findUngroupableLine(restLines)
  if (badLine !== null) {
    return {
      ok: false,
      reason: `Log has a line that isn't part of a dated entry, so clean up was skipped: "${badLine.trim()}"`,
    }
  }

  const entries = parseLogBody(body.slice(titleOffset))
  if (entries.length === 0) {
    return { ok: true, body }
  }

  const monthOrder: string[] = []
  const buckets = new Map<string, LogEntry[]>()
  for (const entry of entries) {
    const m = monthOf(entry.date)
    if (!buckets.has(m)) {
      buckets.set(m, [])
      monthOrder.push(m)
    }
    buckets.get(m)?.push(entry)
  }

  const headingMode = settings.logDateHeadingLevel > 0
  const dayIndent = headingMode ? '' : INDENT_UNIT
  const contentIndent = headingMode ? '' : INDENT_UNIT + INDENT_UNIT

  const parts: string[] = []
  for (const m of monthOrder) {
    parts.push(buildMonthLine(m, settings))
    for (const entry of buckets.get(m) ?? []) {
      parts.push(dayIndent + buildDateLine(entry.date, settings))
      for (const line of entry.lines) {
        parts.push(contentIndent + line)
      }
    }
  }

  const newBody = (titleLine !== null ? `${titleLine}\n` : '') + parts.join('\n') + '\n'
  return { ok: true, body: newBody }
}

// ---------------------------------------------------------------------------
// insertNewEntry
// ---------------------------------------------------------------------------

export function insertNewEntry(
  view: EditorView,
  directive: ParsedDirective,
  settings: DirectivesSettings,
  dateISO: string = todayISO(),
): void {
  const openingLine = view.state.doc.lineAt(directive.from)
  const bodyStart = openingLine.to + 1
  const body = directive.body ?? ''

  const point = locateLogInsertion(body, dateISO, settings)

  if (point.found) {
    const contentStart = bodyStart + point.dateLineStart + point.dateLineLength + 1
    const nextLine = point.nextLineText
    if (nextLine.trim().startsWith('-')) {
      view.dispatch({ selection: { anchor: contentStart + nextLine.length } })
    } else {
      view.dispatch({
        changes: { from: contentStart, insert: point.contentPrefix + '\n' },
        selection: { anchor: contentStart + point.contentPrefix.length },
      })
    }
    view.focus()
    return
  }

  if (point.needsMonthLine && resolveMonthHeadingLevel(settings) === null) {
    new Notice('Can\'t create a new month group — check the month heading level setting.')
    return
  }

  const dateLineText = point.dateIndent + buildDateLine(dateISO, settings)
  const toInsert = point.needsMonthLine
    ? `${buildMonthLine(point.monthStr ?? monthOf(dateISO), settings)}\n${dateLineText}\n${point.contentPrefix}\n`
    : `${dateLineText}\n${point.contentPrefix}\n`

  const absPos = bodyStart + point.insertAt
  // Remove any blank lines between insertAt and the next content/fence so
  // they don't appear below the newly inserted entry.
  const blankCharsAfter = point.scanEnd - point.insertAt
  view.dispatch({
    changes: { from: absPos, to: absPos + blankCharsAfter, insert: toInsert },
    selection: { anchor: absPos + toInsert.length - 1 },
  })
  view.focus()
}

// ---------------------------------------------------------------------------
// Fold helpers
// ---------------------------------------------------------------------------

/**
 * Returns fold ranges for each date heading line inside the directive body,
 * resolved via the editor's foldService so ranges exactly match what
 * Obsidian's fold extension expects.
 */
function headingFoldRanges(
  view: EditorView,
  directive: ParsedDirective,
): { from: number; to: number }[] {
  const state = view.state
  const doc = state.doc
  const openLine = doc.lineAt(directive.from)
  const bodyStart = openLine.to + 1
  const closeLine = doc.lineAt(directive.to)

  const ranges: { from: number; to: number }[] = []

  // Once grouped, fold at month granularity (folding a month natively hides
  // all its days) rather than day granularity — otherwise "collapse all"
  // would defeat the point of grouping.
  const bodyText = doc.sliceString(bodyStart, closeLine.from)
  const entryRe = isGroupedBody(bodyText) ? MONTH_RE : DATE_RE

  for (let pos = bodyStart; pos < closeLine.from; ) {
    const line = doc.lineAt(pos)
    if (!/^[ \t]/.test(line.text) && entryRe.test(line.text.trimEnd())) {
      // Ask each registered fold service for the canonical range at this line.
      for (const fn of state.facet(foldService)) {
        const r = fn(state, line.from, line.to)
        if (r) {
          // Clamp to directive body — foldService is unaware of ::: fences and
          // may extend the last heading's range past the closing fence into the
          // next directive, which would suppress that directive's action widget.
          ranges.push({ from: r.from, to: Math.min(r.to, closeLine.from - 1) })
          break
        }
      }
    }
    if (line.to + 1 > doc.length) break
    pos = line.to + 1
  }

  return ranges
}

function anyFolded(view: EditorView, directive: ParsedDirective): boolean {
  const folded = foldedRanges(view.state)
  const ranges = headingFoldRanges(view, directive)
  let cursor = folded.iter()
  const foldedFroms = new Set<number>()
  while (cursor.value !== null) { foldedFroms.add(cursor.from); cursor.next() }
  return ranges.some(r => foldedFroms.has(r.from))
}

/**
 * Fold/unfold entries based on a search query.
 * Entries whose date or content lines contain the query (case-insensitive)
 * are unfolded; non-matching entries are folded.
 * Pass an empty query to unfold all.
 */
function applySearchFilter(
  view: EditorView,
  directive: ParsedDirective,
  query: string,
): void {
  const state = view.state
  const doc = state.doc
  const q = query.toLowerCase().trim()
  const openLine = doc.lineAt(directive.from)
  const bodyStart = openLine.to + 1
  const closeLine = doc.lineAt(directive.to)

  // Build list of {dateLineFrom, dateLineTo, contentText, foldRange}
  interface Section {
    foldRange: { from: number; to: number } | null
    matches: boolean
  }

  const sections: Section[] = []
  let current: { from: number; to: number; lines: string[] } | null = null

  const bodyText = doc.sliceString(bodyStart, closeLine.from)
  const entryRe = isGroupedBody(bodyText) ? MONTH_RE : DATE_RE

  for (let pos = bodyStart; pos < closeLine.from; ) {
    const line = doc.lineAt(pos)
    if (!/^[ \t]/.test(line.text) && entryRe.test(line.text.trimEnd())) {
      if (current) {
        let foldRange: { from: number; to: number } | null = null
        for (const fn of state.facet(foldService)) {
          const r = fn(state, doc.lineAt(current.from).from, doc.lineAt(current.from).to)
          if (r) { foldRange = r; break }
        }
        sections.push({
          foldRange,
          matches: !q || current.lines.some(l => l.toLowerCase().includes(q)),
        })
      }
      current = { from: line.from, to: line.to, lines: [line.text] }
    } else if (current) {
      current.lines.push(line.text)
    }
    if (line.to + 1 > doc.length) break
    pos = line.to + 1
  }
  if (current) {
    let foldRange: { from: number; to: number } | null = null
    for (const fn of state.facet(foldService)) {
      const r = fn(state, doc.lineAt(current.from).from, doc.lineAt(current.from).to)
      if (r) { foldRange = r; break }
    }
    sections.push({
      foldRange,
      matches: !q || current.lines.some(l => l.toLowerCase().includes(q)),
    })
  }

  const folded = foldedRanges(state)
  let cursor = folded.iter()
  const foldedFroms = new Set<number>()
  while (cursor.value !== null) { foldedFroms.add(cursor.from); cursor.next() }

  const effects = []
  for (const section of sections) {
    if (!section.foldRange) continue
    const isFolded = foldedFroms.has(section.foldRange.from)
    if (!section.matches && !isFolded) {
      effects.push(foldEffect.of(section.foldRange))
    } else if (section.matches && isFolded) {
      effects.push(unfoldEffect.of(section.foldRange))
    }
  }
  if (effects.length) view.dispatch({ effects })
}

function toggleFoldAll(view: EditorView, directive: ParsedDirective): boolean {
  const ranges = headingFoldRanges(view, directive)
  if (ranges.length === 0) return false
  const collapse = !anyFolded(view, directive)
  const folded = foldedRanges(view.state)
  let cursor = folded.iter()
  const foldedFroms = new Set<number>()
  while (cursor.value !== null) { foldedFroms.add(cursor.from); cursor.next() }
  const effects = ranges
    .filter(r => collapse ? !foldedFroms.has(r.from) : foldedFroms.has(r.from))
    .map(r => (collapse ? foldEffect : unfoldEffect).of(r))
  if (effects.length) view.dispatch({ effects })
  return collapse
}

// ---------------------------------------------------------------------------
// Search state — persisted across widget rebuilds keyed by directive position
// ---------------------------------------------------------------------------

interface SearchState { query: string; open: boolean }
const searchStateMap = new Map<number, SearchState>()


// ---------------------------------------------------------------------------
// LogActionsWidget — inline at end of the opening fence line
// ---------------------------------------------------------------------------

class LogActionsWidget extends WidgetType {
  constructor(
    private readonly directive: ParsedDirective,
    private readonly settings: DirectivesSettings,
  ) {
    super()
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof LogActionsWidget)) return false
    if (other.directive.from !== this.directive.from) return false
    if (other.directive.body !== this.directive.body) return false
    // Also re-render if search state changed so the open/closed class is correct.
    const state = searchStateMap.get(this.directive.from)
    const otherState = searchStateMap.get(other.directive.from)
    return state?.open === otherState?.open && state?.query === otherState?.query
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('span')
    wrap.className = 'directive-log-actions'

    const dateInput = activeDocument.createElement('input')
    dateInput.type = 'date'
    dateInput.className = 'directive-log-actions-date-input'
    dateInput.value = todayISO()
    dateInput.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    dateInput.addEventListener('change', () => {
      const picked = dateInput.value
      if (picked) insertNewEntry(view, this.directive, this.settings, picked)
      dateInput.value = todayISO()
    })

    const calBtn = activeDocument.createElement('button')
    calBtn.className = 'clickable-icon directive-log-actions-btn'
    calBtn.setAttribute('aria-label', 'Pick date for new log entry')
    setIcon(calBtn, 'calendar')
    calBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    calBtn.addEventListener('click', () => dateInput.showPicker())

    const newBtn = activeDocument.createElement('button')
    newBtn.className = 'clickable-icon directive-log-actions-btn'
    newBtn.setAttribute('aria-label', 'Add log entry for today')
    setIcon(newBtn, 'plus')
    newBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    newBtn.addEventListener('click', () => insertNewEntry(view, this.directive, this.settings))

    const foldBtn = activeDocument.createElement('button')
    foldBtn.className = 'clickable-icon directive-log-actions-btn'
    // Sync initial icon to actual fold state so it's correct after a widget rebuild.
    const initiallyFolded = anyFolded(view, this.directive)
    setIcon(foldBtn, initiallyFolded ? 'chevrons-up-down' : 'chevrons-down-up')
    foldBtn.setAttribute('aria-label', initiallyFolded ? 'Expand all log entries' : 'Collapse all log entries')
    foldBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    foldBtn.addEventListener('click', () => {
      const didCollapse = toggleFoldAll(view, this.directive)
      setIcon(foldBtn, didCollapse ? 'chevrons-up-down' : 'chevrons-down-up')
      foldBtn.setAttribute('aria-label', didCollapse ? 'Expand all log entries' : 'Collapse all log entries')
    })

    // Search — button always visible, container slides open beside it.
    // State (query + open) is persisted in searchStateMap across widget rebuilds.
    const savedSearch = searchStateMap.get(this.directive.from) ?? { query: '', open: false }

    const searchWrap = activeDocument.createElement('div')
    searchWrap.className = 'directive-log-search-wrap'
    if (savedSearch.open) {
      searchWrap.classList.add('is-open')
      wrap.classList.add('is-search-open')
    }

    const searchIconEl = activeDocument.createElement('span')
    searchIconEl.className = 'directive-log-search-icon'
    setIcon(searchIconEl, 'search')
    searchWrap.appendChild(searchIconEl)

    const searchInput = activeDocument.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = 'Search…'
    searchInput.className = 'directive-log-search-input'
    if (savedSearch.query) {
      searchInput.value = savedSearch.query
      applySearchFilter(view, this.directive, savedSearch.query)
    }
    searchInput.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        searchInput.value = ''
        applySearchFilter(view, this.directive, '')
        searchWrap.classList.remove('is-open')
        wrap.classList.remove('is-search-open')
        searchInput.blur()
        searchStateMap.set(this.directive.from, { query: '', open: false })
      }
    })
    searchInput.addEventListener('input', () => {
      applySearchFilter(view, this.directive, searchInput.value)
      searchStateMap.set(this.directive.from, { query: searchInput.value, open: true })
    })
    searchWrap.appendChild(searchInput)

    const searchBtn = activeDocument.createElement('button')
    searchBtn.className = 'clickable-icon directive-log-actions-btn'
    searchBtn.setAttribute('aria-label', 'Search log entries')
    setIcon(searchBtn, 'search')
    searchBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    searchBtn.addEventListener('click', () => {
      const isOpen = searchWrap.classList.toggle('is-open')
      wrap.classList.toggle('is-search-open', isOpen)
      if (isOpen) {
        searchInput.focus()
        searchStateMap.set(this.directive.from, { query: searchInput.value, open: true })
      } else {
        searchInput.value = ''
        applySearchFilter(view, this.directive, '')
        searchStateMap.set(this.directive.from, { query: '', open: false })
      }
    })

    const editBtn = activeDocument.createElement('button')
    editBtn.className = 'clickable-icon directive-log-actions-btn'
    editBtn.setAttribute('aria-label', 'Edit this block')
    setIcon(editBtn, 'code-2')
    editBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    editBtn.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    wrap.appendChild(dateInput)
    wrap.appendChild(searchWrap)
    wrap.appendChild(searchBtn)
    wrap.appendChild(foldBtn)
    wrap.appendChild(calBtn)
    wrap.appendChild(newBtn)
    wrap.appendChild(editBtn)

    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

// ---------------------------------------------------------------------------
// LogHintWidget — ghost-text shown when the log has no date entries yet
// ---------------------------------------------------------------------------

class LogHintWidget extends WidgetType {
  eq(other: WidgetType): boolean { return other instanceof LogHintWidget }

  toDOM(): HTMLElement {
    const el = activeDocument.createElement('span')
    el.className = 'directive-log-hint'
    el.textContent = 'Press + to add your first entry'
    return el
  }

  ignoreEvent(): boolean { return true }
}

// ---------------------------------------------------------------------------
// Dummy widget — render() required by interface, never called for in-place
// ---------------------------------------------------------------------------

class NeverRenderedWidget extends DirectiveWidget {
  toDOM(): HTMLElement {
    return activeDocument.createElement('span')
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createLogHandler(_app: unknown, settings: DirectivesSettings): DirectiveHandler {
  return {
    name: 'log',
    decorateInPlace: true,

    buildActionWidget(directive: ParsedDirective, _state: EditorState): WidgetType {
      return new LogActionsWidget(directive, settings)
    },

    pruneState(activeFroms: Set<number>): void {
      for (const key of searchStateMap.keys()) {
        if (!activeFroms.has(key)) searchStateMap.delete(key)
      }
    },

    buildHintWidget(directive: ParsedDirective, _state: EditorState): WidgetType | null {
      const entries = parseLogBody(directive.body ?? '')
      return entries.length === 0 ? new LogHintWidget() : null
    },

    render(_directive: ParsedDirective, _state: EditorState): DirectiveWidget {
      return new NeverRenderedWidget()
    },

    getInsertionBody(): string {
      const level = settings.logTitleHeadingLevel
      if (level > 0) {
        return `${'#'.repeat(level)} Log\n`
      }
      return ''
    },
  }
}
