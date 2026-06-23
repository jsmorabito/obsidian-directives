/**
 * handlers/log.ts
 *
 * Implements the :::log directive — a chronological activity log rendered
 * in-place (decorateInPlace: true). The raw Markdown is always visible and
 * editable. A small action widget is placed at the end of the opening fence
 * line for "New entry" / date-picker buttons.
 */

import { setIcon } from 'obsidian'
import { EditorView, WidgetType } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { foldEffect, unfoldEffect, foldedRanges, foldService } from '@codemirror/language'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import type { DirectivesSettings } from '../settings'

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

const DATE_RE =
  /^(?:-|#{1,6})\s+(?:\[\[(?:[^\]|]*\/)?(\d{4}-\d{2}-\d{2})[^\]]*\]\]|(\d{4}-\d{2}-\d{2}))\s*$/

function extractDate(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? ''
}

export interface LogEntry {
  date: string
  dateOffset: number
  lines: string[]
  lineOffsets: number[]
}

export function parseLogBody(body: string): LogEntry[] {
  const entries: LogEntry[] = []
  let current: LogEntry | null = null
  let offset = 0

  for (const raw of body.split('\n')) {
    const dateMatch = DATE_RE.exec(raw.trimEnd())
    if (dateMatch) {
      current = { date: extractDate(dateMatch), dateOffset: offset, lines: [], lineOffsets: [] }
      entries.push(current)
    } else if (current && raw.trim()) {
      current.lineOffsets.push(offset)
      const stripped = raw.replace(/^(\t|  {1,4})/, '')
      current.lines.push(stripped)
    }
    offset += raw.length + 1
  }

  return entries
}

function todayISO(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
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
  const bodyLines = body.split('\n')

  const firstBodyLine = bodyLines[0]?.trimEnd() ?? ''
  const firstIsTitle = firstBodyLine.startsWith('#') && !DATE_RE.exec(firstBodyLine)
  const titleOffset = firstIsTitle ? firstBodyLine.length + 1 : 0

  let insertOffset = titleOffset
  let charCount = titleOffset
  const scanFrom = firstIsTitle ? 1 : 0

  for (let i = scanFrom; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? ''
    const match = DATE_RE.exec(line.trimEnd())

    if (match) {
      const existingDate = extractDate(match)

      if (dateISO === existingDate) {
        const contentStart = bodyStart + charCount + line.length + 1
        const nextLine = bodyLines[i + 1] ?? ''
        if (nextLine.trim().startsWith('-')) {
          view.dispatch({ selection: { anchor: contentStart + nextLine.length } })
        } else {
          const sub = settings.logDateHeadingLevel > 0 ? '- ' : '    - '
          view.dispatch({
            changes: { from: contentStart, insert: sub + '\n' },
            selection: { anchor: contentStart + sub.length },
          })
        }
        view.focus()
        return
      }

      if (dateISO > existingDate) break
    }

    charCount += line.length + 1
    // Don't advance insertOffset over empty lines — this prevents blank lines
    // between the title heading and the first inserted date entry.
    if (line.trim()) insertOffset = charCount
  }

  const subItem = settings.logDateHeadingLevel > 0 ? '- ' : '    - '
  const toInsert = `${buildDateLine(dateISO, settings)}\n${subItem}\n`
  const absPos = bodyStart + insertOffset
  // Remove any blank lines between insertOffset and the next content/fence so
  // they don't appear below the newly inserted entry.
  const blankCharsAfter = charCount - insertOffset
  view.dispatch({
    changes: { from: absPos, to: absPos + blankCharsAfter, insert: toInsert },
    selection: { anchor: absPos + toInsert.length - 1 },
  })
  view.focus()
}

function buildDateLine(dateISO: string, settings: DirectivesSettings): string {
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

  for (let pos = bodyStart; pos < closeLine.from; ) {
    const line = doc.lineAt(pos)
    if (DATE_RE.exec(line.text)) {
      // Ask each registered fold service for the canonical range at this line.
      for (const fn of state.facet(foldService)) {
        const r = fn(state, line.from, line.to)
        if (r) { ranges.push(r); break }
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

  for (let pos = bodyStart; pos < closeLine.from; ) {
    const line = doc.lineAt(pos)
    if (DATE_RE.exec(line.text)) {
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
    return (
      other instanceof LogActionsWidget &&
      other.directive.from === this.directive.from &&
      other.directive.body === this.directive.body
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('span')
    wrap.className = 'directive-log-actions'

    const dateInput = activeDocument.createElement('input')
    dateInput.type = 'date'
    dateInput.className = 'directive-log-actions-date-input'
    dateInput.value = todayISO()
    dateInput.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    dateInput.addEventListener('change', () => {
      const picked = dateInput.value
      if (picked) insertNewEntry(view, this.directive, this.settings, picked)
      dateInput.value = todayISO()
    })

    const calBtn = activeDocument.createElement('button')
    calBtn.className = 'clickable-icon directive-log-actions-btn'
    calBtn.setAttribute('aria-label', 'Pick date for new log entry')
    setIcon(calBtn, 'calendar')
    calBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    calBtn.addEventListener('click', () => dateInput.showPicker())

    const newBtn = activeDocument.createElement('button')
    newBtn.className = 'clickable-icon directive-log-actions-btn'
    newBtn.setAttribute('aria-label', 'Add log entry for today')
    setIcon(newBtn, 'plus')
    newBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    newBtn.addEventListener('click', () => insertNewEntry(view, this.directive, this.settings))

    const foldBtn = activeDocument.createElement('button')
    foldBtn.className = 'clickable-icon directive-log-actions-btn'
    foldBtn.setAttribute('aria-label', 'Collapse all log entries')
    setIcon(foldBtn, 'chevrons-down-up')
    foldBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    foldBtn.addEventListener('click', () => {
      const didCollapse = toggleFoldAll(view, this.directive)
      setIcon(foldBtn, didCollapse ? 'chevrons-up-down' : 'chevrons-down-up')
      foldBtn.setAttribute('aria-label', didCollapse ? 'Expand all log entries' : 'Collapse all log entries')
    })

    // Search — button always visible, input slides open beside it
    const searchInput = activeDocument.createElement('input')
    searchInput.type = 'text'
    searchInput.placeholder = 'Search…'
    searchInput.className = 'directive-log-search-input'
    searchInput.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Escape') {
        searchInput.value = ''
        applySearchFilter(view, this.directive, '')
        searchInput.classList.remove('is-open')
        searchInput.blur()
      }
    })
    searchInput.addEventListener('input', () => {
      applySearchFilter(view, this.directive, searchInput.value)
    })

    const searchBtn = activeDocument.createElement('button')
    searchBtn.className = 'clickable-icon directive-log-actions-btn'
    searchBtn.setAttribute('aria-label', 'Search log entries')
    setIcon(searchBtn, 'search')
    searchBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    searchBtn.addEventListener('click', () => {
      const isOpen = searchInput.classList.toggle('is-open')
      if (isOpen) {
        searchInput.focus()
      } else {
        searchInput.value = ''
        applySearchFilter(view, this.directive, '')
      }
    })

    wrap.appendChild(dateInput)
    wrap.appendChild(searchInput)
    wrap.appendChild(searchBtn)
    wrap.appendChild(foldBtn)
    wrap.appendChild(calBtn)
    wrap.appendChild(newBtn)

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
