/**
 * handlers/log.ts
 *
 * Implements the :::log directive — a chronological activity log
 * with a "New entry" button that prepends today's date entry.
 *
 * Syntax:
 *   :::log
 *   - 2026-06-17
 *     - some note
 *     - another note
 *   - 2026-06-16
 *     - earlier note
 *   :::
 *
 * Body format:
 *   - Top-level list items matching YYYY-MM-DD are treated as date headings.
 *   - All indented lines beneath a date are rendered as content items.
 *   - Non-date top-level lines are ignored.
 */

import { App, setIcon } from 'obsidian'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import type { DirectivesSettings } from '../settings'

// ---------------------------------------------------------------------------
// Body parser
// ---------------------------------------------------------------------------

// Matches list-item dates:  - 2026-06-17  or  - [[2026-06-17]]
// Matches heading dates:    ## 2026-06-17  or  ###### [[Daily/2026-06-17]]
// Capture group 1: date from wikilink path, group 2: plain date
const DATE_RE =
  /^(?:-|#{1,6})\s+(?:\[\[(?:[^\]|]*\/)?(\d{4}-\d{2}-\d{2})[^\]]*\]\]|(\d{4}-\d{2}-\d{2}))\s*$/

function extractDate(match: RegExpExecArray): string {
  return match[1] ?? match[2] ?? ''
}

interface LogEntry {
  date: string           // "YYYY-MM-DD"
  dateOffset: number     // char offset of the date line from body start
  lines: string[]        // content lines (leading indent stripped for display)
  lineOffsets: number[]  // char offset of each content line from body start
}

function parseLogBody(body: string): LogEntry[] {
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
    offset += raw.length + 1  // +1 for the \n
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
// LogWidget
// ---------------------------------------------------------------------------

class LogWidget extends DirectiveWidget {
  constructor(
    private readonly directive: ParsedDirective,
    private readonly settings: DirectivesSettings,
    private readonly app: App,
  ) {
    super()
  }

  eq(other: LogWidget): boolean {
    if (!(other instanceof LogWidget)) return false
    return (
      this.directive.body        === other.directive.body &&
      this.directive.label       === other.directive.label &&
      this.settings.logDateStyle        === other.settings.logDateStyle &&
      this.settings.logDateFormat       === other.settings.logDateFormat &&
      this.settings.logDateHeadingLevel === other.settings.logDateHeadingLevel
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('div')
    wrap.className = 'directive-widget directive-widget--log'

    // Required convention: click moves cursor into the block so the
    // StateField tears down the decoration and shows raw Markdown.
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    const title = this.directive.label ?? 'Log'
    const entries = parseLogBody(this.directive.body ?? '')

    // bodyStart: document offset of the first character of the directive body.
    const openingLine = view.state.doc.lineAt(this.directive.from)
    const bodyStart = openingLine.to + 1

    const header = this.buildHeader(title, view)
    wrap.appendChild(header)
    wrap.appendChild(this.buildEntries(entries, bodyStart, view))

    return wrap
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  private buildHeader(title: string, view: EditorView): HTMLElement {
    const header = activeDocument.createElement('div')
    header.className = 'directive-log-header'
    header.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    const titleEl = activeDocument.createElement('span')
    titleEl.className = 'directive-log-title'
    titleEl.textContent = title

    const btn = activeDocument.createElement('button')
    btn.className = 'directive-log-new-btn'
    btn.textContent = 'New entry'
    btn.setAttribute('aria-label', 'Add new log entry for today')
    btn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    btn.addEventListener('click', () => this.insertNewEntry(view))

    // Hidden date input — triggered by the calendar button.
    const dateInput = activeDocument.createElement('input')
    dateInput.type = 'date'
    dateInput.className = 'directive-log-date-input'
    dateInput.value = todayISO()
    dateInput.setAttribute('aria-label', 'Pick a date for a new log entry')
    dateInput.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    dateInput.addEventListener('change', () => {
      const picked = dateInput.value   // "YYYY-MM-DD" or "" if cleared
      if (picked) this.insertNewEntry(view, picked)
      // Reset to today so re-opening the picker always starts fresh.
      dateInput.value = todayISO()
    })

    const calBtn = activeDocument.createElement('button')
    calBtn.className = 'directive-log-cal-btn'
    calBtn.setAttribute('aria-label', 'Pick a date for a new log entry')
    calBtn.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    calBtn.addEventListener('click', () => dateInput.showPicker())
    setIcon(calBtn, 'calendar')

    const btnGroup = activeDocument.createElement('div')
    btnGroup.className = 'directive-log-btn-group'
    btnGroup.appendChild(calBtn)
    btnGroup.appendChild(btn)

    header.appendChild(titleEl)
    header.appendChild(btnGroup)
    // Input appended last — absolutely positioned within the header so it
    // anchors the picker near the right side without entering flex flow.
    header.appendChild(dateInput)
    return header
  }

  // -------------------------------------------------------------------------
  // Entry list
  // -------------------------------------------------------------------------

  private buildEntries(entries: LogEntry[], bodyStart: number, view: EditorView): HTMLElement {
    const list = activeDocument.createElement('div')
    list.className = 'directive-log-entries'

    if (entries.length === 0) {
      const empty = activeDocument.createElement('div')
      empty.className = 'directive-log-empty'
      empty.textContent = 'No entries yet. Click "New entry" to start.'
      list.appendChild(empty)
      return list
    }

    for (const entry of entries) {
      list.appendChild(this.buildEntry(entry, bodyStart, view))
    }

    return list
  }

  private buildEntry(entry: LogEntry, bodyStart: number, view: EditorView): HTMLElement {
    const section = activeDocument.createElement('div')
    section.className = 'directive-log-entry'

    // Clicking anywhere in this entry places the cursor at its date line.
    const dateCursorPos = bodyStart + entry.dateOffset
    section.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: dateCursorPos } })
      view.focus()
    })

    const dateEl = activeDocument.createElement('div')
    dateEl.className = 'directive-log-date'

    if (this.settings.logDateStyle === 'wikilink') {
      const fmt = this.settings.logDateFormat || '{{date}}'
      const target = fmt.replace('{{date}}', entry.date)
      const link = activeDocument.createElement('a')
      link.className = 'internal-link directive-log-date-link'
      link.setAttribute('data-href', target)
      link.setAttribute('href', target)
      link.textContent = entry.date
      link.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
      link.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const mod = e.ctrlKey || e.metaKey
        ;(this.app as unknown as { workspace: { openLinkText(t: string, s: string, n: boolean): void } })
          .workspace.openLinkText(target, '', mod)
      })
      dateEl.appendChild(link)
    } else {
      dateEl.textContent = entry.date
    }

    section.appendChild(dateEl)

    if (entry.lines.length > 0) {
      const content = activeDocument.createElement('ul')
      content.className = 'directive-log-content'
      this.buildItems(content, entry.lines, entry.lineOffsets, bodyStart, view)
      section.appendChild(content)
    }

    return section
  }

  /**
   * Render a flat list of indented lines as nested <ul>/<li> elements.
   * Each item gets a mousedown handler that places the cursor at its source line.
   */
  private buildItems(
    parent: HTMLUListElement,
    lines: string[],
    lineOffsets: number[],
    bodyStart: number,
    view: EditorView,
  ): void {
    // Stack of [indent-depth, ul-element] pairs.
    const stack: Array<[number, HTMLUListElement]> = [[0, parent]]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
      const text = line.replace(/^\s*-\s*/, '').trim()
      if (!text) continue

      // Pop stack until we find the right nesting level.
      while (stack.length > 1 && (stack[stack.length - 1]?.[0] ?? 0) > indent) {
        stack.pop()
      }

      const currentList = stack[stack.length - 1]?.[1] ?? parent

      const li = activeDocument.createElement('li')
      li.className = 'directive-log-item'
      li.textContent = text
      // Clicking this item places the cursor at its source line.
      const itemOffset = lineOffsets[i]
      if (itemOffset !== undefined) {
        li.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
          view.dispatch({ selection: { anchor: bodyStart + itemOffset } })
          view.focus()
        })
      }
      currentList.appendChild(li)

      // If next line is more indented, prepare a child list on this item.
      const nextLine = lines[i + 1]
      if (nextLine !== undefined) {
        const nextIndent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0
        if (nextIndent > indent) {
          const childList = activeDocument.createElement('ul')
          childList.className = 'directive-log-content'
          li.appendChild(childList)
          stack.push([nextIndent, childList])
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // "New entry" — inserts today's date block at the top of the body
  // -------------------------------------------------------------------------

  private insertNewEntry(view: EditorView, dateISO: string = todayISO()): void {
    const openingLine = view.state.doc.lineAt(this.directive.from)
    const bodyStart = openingLine.to + 1   // character after the opening fence's \n

    const body = this.directive.body ?? ''
    const bodyLines = body.split('\n')

    // Skip the title heading line (e.g. "## Log") if present.
    const firstBodyLine = bodyLines[0]?.trimEnd() ?? ''
    const firstIsTitle = firstBodyLine.startsWith('#') && !DATE_RE.exec(firstBodyLine)
    const titleOffset = firstIsTitle ? firstBodyLine.length + 1 : 0

    // Walk all lines to find the correct chronological insertion point.
    // Entries are ordered newest-first, so insert before the first entry older than dateISO.
    let insertOffset = titleOffset
    let charCount = titleOffset
    const scanFrom = firstIsTitle ? 1 : 0

    for (let i = scanFrom; i < bodyLines.length; i++) {
      const line = bodyLines[i] ?? ''
      const match = DATE_RE.exec(line.trimEnd())

      if (match) {
        const existingDate = extractDate(match)

        if (dateISO === existingDate) {
          // Duplicate — place cursor at this entry's first content line.
          const contentStart = bodyStart + charCount + line.length + 1
          const nextLine = bodyLines[i + 1] ?? ''
          if (nextLine.trim().startsWith('-')) {
            view.dispatch({ selection: { anchor: contentStart + nextLine.length } })
          } else {
            const sub = this.settings.logDateHeadingLevel > 0 ? '- ' : '    - '
            view.dispatch({
              changes: { from: contentStart, insert: sub + '\n' },
              selection: { anchor: contentStart + sub.length },
            })
          }
          view.focus()
          return
        }

        if (dateISO > existingDate) {
          // New date is newer — insert before this existing entry.
          break
        }
      }

      // Advance past this line (+1 for the newline character).
      charCount += line.length + 1
      insertOffset = charCount
    }

    const subItem = this.settings.logDateHeadingLevel > 0 ? '- ' : '    - '
    const toInsert = `${this.buildDateLine(dateISO)}\n${subItem}\n`
    const absPos = bodyStart + insertOffset
    view.dispatch({
      changes: { from: absPos, insert: toInsert },
      selection: { anchor: absPos + toInsert.length - 1 },
    })
    view.focus()
  }

  /** Returns the markdown line for a date entry, respecting date style and heading level settings. */
  private buildDateLine(dateISO: string): string {
    const prefix = this.settings.logDateHeadingLevel > 0
      ? '#'.repeat(this.settings.logDateHeadingLevel)
      : '-'

    if (this.settings.logDateStyle === 'wikilink') {
      const fmt = this.settings.logDateFormat || '{{date}}'
      const target = fmt.replace('{{date}}', dateISO)
      return `${prefix} [[${target}]]`
    }
    return `${prefix} ${dateISO}`
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create the log directive handler.
 * Call once in plugin onload() and register via plugin.addHandler().
 * Receives a live reference to settings so changes take effect on next render.
 */
export function createLogHandler(app: App, settings: DirectivesSettings): DirectiveHandler {
  return {
    name: 'log',

    render(directive: ParsedDirective, _state: EditorState): DirectiveWidget {
      return new LogWidget(directive, settings, app)
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
