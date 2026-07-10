/**
 * handlers/checklist.ts
 *
 * Implements the :::checklist directive — an interactive task list that
 * aggregates checkboxes from vault files and/or an inline body.
 *
 * Syntax:
 *   :::checklist[Title]{from="path/to/note.md" filter=todo}
 *   - [ ] Inline task one
 *   - [x] Inline task two
 *   :::
 *
 * Attributes:
 *   from    — Comma-separated vault paths or bare filenames to pull tasks from.
 *             Resolved via metadataCache (bare names) or exact path.
 *             Omit to use only the inline body.
 *   filter  — "todo" | "done" | "all" (default: "all")
 *
 * Behaviour:
 *   - Tasks from `from=` files are listed first, then inline body tasks.
 *   - Toggling a checkbox writes the change back to its source file.
 *   - Editing task text (click label) writes the change back to source.
 *   - When a watched source file changes externally the list refreshes.
 */

import { AbstractInputSuggest, App, Menu, Modal, Setting, TAbstractFile, TFile, prepareFuzzySearch, setIcon } from 'obsidian'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { parseWhere, matchesFrontmatter, resolveFile, debounce } from '../core/utils'
import type { WhereCondition } from '../core/utils'

// ---------------------------------------------------------------------------
// Task model
// ---------------------------------------------------------------------------

interface Task {
  checked: boolean
  text: string
  /** Vault path of the file this task lives in, or null for inline body tasks. */
  sourcePath: string | null
  /** Byte offset of the `[ ]` / `[x]` within the source file content. */
  checkboxOffset: number
  /** Byte offset of the start of the task text within the source file. */
  textOffset: number
  /** Full length of the raw task line (not including newline). */
  lineLength: number
  /** 0-based line number within the source file (for jump-to). */
  lineNumber: number
  /**
   * Name of the directive block this task lives inside (e.g. "log"), or null
   * if the task is in the top-level note body.
   */
  directiveContext: string | null
  /** Label of the containing directive block, if present. */
  directiveLabel: string | null
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TASK_LINE_RE = /^- \[([ xX])\] (.*)/
const DIRECTIVE_OPEN_RE = /^:{3,}([a-zA-Z][\w-]*)(?:\[([^\]]*)\])?/
const DIRECTIVE_CLOSE_RE = /^:{3,}\s*$/

export function parseTasks(content: string, sourcePath: string | null): Task[] {
  const tasks: Task[] = []
  let offset = 0
  let lineNumber = 0

  // Stack of { name, label, fenceLen } for nested directives
  const stack: { name: string; label: string | null; fenceLen: number }[] = []

  for (const line of content.split('\n')) {
    const trimmed = line.trimEnd()

    const openMatch = DIRECTIVE_OPEN_RE.exec(trimmed)
    if (openMatch) {
      const fenceLen = ((trimmed.match(/^:+/) ?? [':::'])[0] ?? ':::').length
      stack.push({ name: openMatch[1] ?? '', label: openMatch[2] ?? null, fenceLen })
    } else if (DIRECTIVE_CLOSE_RE.test(trimmed) && stack.length > 0) {
      const fenceLen = ((trimmed.match(/^:+/) ?? [':::'])[0] ?? ':::').length
      // Pop the most recent frame whose fence length matches
      for (let i = stack.length - 1; i >= 0; i--) {
        if ((stack[i]?.fenceLen ?? 0) === fenceLen) {
          stack.splice(i, 1)
          break
        }
      }
    } else {
      const m = TASK_LINE_RE.exec(line)
      if (m && (m[2] ?? '').trim()) {
        const top = stack[stack.length - 1] ?? null
        tasks.push({
          checked: m[1] !== ' ',
          text: m[2] ?? '',
          sourcePath,
          checkboxOffset: offset + 3,
          textOffset: offset + 6,
          lineLength: line.length,
          lineNumber,
          directiveContext: top?.name ?? null,
          directiveLabel:   top?.label ?? null,
        })
      }
    }

    offset += line.length + 1
    lineNumber++
  }
  return tasks
}

type FilterMode = 'todo' | 'done' | 'all'

export function applyFilter(tasks: Task[], filter: FilterMode): Task[] {
  if (filter === 'todo') return tasks.filter(t => !t.checked)
  if (filter === 'done') return tasks.filter(t => t.checked)
  return tasks
}

// ---------------------------------------------------------------------------
// Attribute editing helpers
// ---------------------------------------------------------------------------

/**
 * Set or remove a single attribute on the directive's opening fence line.
 * Handles key=val and key="val with spaces" forms.
 * Pass value=null to remove the key entirely.
 */
function setDirectiveLabel(view: EditorView, directive: ParsedDirective, label: string | null): void {
  const line = view.state.doc.lineAt(directive.from)
  const text = line.text
  // Match existing [label] bracket
  const bracketMatch = /\[([^\]]*)\]/.exec(text)
  if (bracketMatch) {
    const from = line.from + (bracketMatch.index ?? 0)
    const to   = from + bracketMatch[0].length
    view.dispatch({ changes: { from, to, insert: label !== null ? `[${label}]` : '' } })
  } else if (label !== null) {
    // Insert [label] after the fence name (e.g. after ":::checklist")
    const nameMatch = /^(:+)(\w[\w-]*)/.exec(text)
    const insertAt  = nameMatch ? line.from + nameMatch[0].length : line.to
    view.dispatch({ changes: { from: insertAt, insert: `[${label}]` } })
  }
}

function setDirectiveAttr(
  view: EditorView,
  directive: ParsedDirective,
  key: string,
  value: string | null,
): void {
  const line  = view.state.doc.lineAt(directive.from)
  const text  = line.text
  const braceMatch = /\{([^}]*)\}/.exec(text)

  if (!braceMatch) {
    if (value !== null) {
      const quoted = /[\s,]/.test(value) ? `"${value}"` : value
      view.dispatch({ changes: { from: line.to, insert: `{${key}=${quoted}}` } })
    }
    return
  }

  const braceFrom = line.from + (braceMatch.index ?? 0)
  const braceTo   = braceFrom + braceMatch[0].length
  let inner       = (braceMatch[1] ?? '')
    .replace(new RegExp(`\\s*\\b${key}=(?:"[^"]*"|\\S+)`), '')
    .trim()

  if (value !== null) {
    const quoted = /[\s,]/.test(value) ? `"${value}"` : value
    inner = inner ? `${inner} ${key}=${quoted}` : `${key}=${quoted}`
  }

  view.dispatch({
    changes: { from: braceFrom, to: braceTo, insert: inner ? `{${inner}}` : '' },
  })
}

// ---------------------------------------------------------------------------
// Tag-based task finder
// ---------------------------------------------------------------------------

/**
 * Find all tasks across the vault whose line contains the given tag,
 * optionally filtered to files matching frontmatter conditions.
 */
async function findTasksByTag(
  tag: string,
  app: App,
  where: WhereCondition[],
): Promise<{ tasks: Task[]; filePaths: string[] }> {
  const normalized = tag.startsWith('#') ? tag : `#${tag}`

  const filePaths: string[] = []
  const tasks: Task[] = []

  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file)
    if (!cache?.tags) continue
    const fileHasTag = cache.tags.some(
      t => t.tag.toLowerCase() === normalized.toLowerCase() ||
           t.tag.toLowerCase().startsWith(normalized.toLowerCase() + '/')
    )
    if (!fileHasTag) continue

    // Apply frontmatter filter
    if (!matchesFrontmatter(cache.frontmatter, where)) continue

    filePaths.push(file.path)
    const content = await app.vault.read(file)
    let offset = 0
    let lineNumber = 0
    const stack: { name: string; label: string | null; fenceLen: number }[] = []

    for (const line of content.split('\n')) {
      const trimmed = line.trimEnd()
      const openMatch = DIRECTIVE_OPEN_RE.exec(trimmed)
      if (openMatch) {
        const fenceLen = ((trimmed.match(/^:+/) ?? [':::'])[0] ?? ':::').length
        stack.push({ name: openMatch[1] ?? '', label: openMatch[2] ?? null, fenceLen })
      } else if (DIRECTIVE_CLOSE_RE.test(trimmed) && stack.length > 0) {
        const fenceLen = ((trimmed.match(/^:+/) ?? [':::'])[0] ?? ':::').length
        for (let i = stack.length - 1; i >= 0; i--) {
          if ((stack[i]?.fenceLen ?? 0) === fenceLen) { stack.splice(i, 1); break }
        }
      } else {
        const m = TASK_LINE_RE.exec(line)
        const lineContainsTag = new RegExp(
          `${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s,;.!?]|$)`, 'i'
        ).test(line)
        if (m && (m[2] ?? '').trim() && lineContainsTag) {
          const top = stack[stack.length - 1] ?? null
          tasks.push({
            checked: m[1] !== ' ',
            text: m[2] ?? '',
            sourcePath: file.path,
            checkboxOffset: offset + 3,
            textOffset: offset + 6,
            lineLength: line.length,
            lineNumber,
            directiveContext: top?.name ?? null,
            directiveLabel:   top?.label ?? null,
          })
        }
      }
      offset += line.length + 1
      lineNumber++
    }
  }

  return { tasks, filePaths }
}

/** Append a path to the `from=` attribute (comma-separated). */
function addSourcePath(view: EditorView, directive: ParsedDirective, newPath: string): void {
  const trimmed  = newPath.trim()
  if (!trimmed) return
  const existing = directive.attributes['from'] ?? ''
  const paths    = existing ? existing.split(',').map(s => s.trim()).filter(Boolean) : []
  if (!paths.includes(trimmed)) paths.push(trimmed)
  setDirectiveAttr(view, directive, 'from', paths.join(', '))
}

// ---------------------------------------------------------------------------
// Fuzzy file suggest for the source input
// ---------------------------------------------------------------------------

class FileSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    inputEl: HTMLInputElement,
    private readonly onChoose: (file: TFile) => void,
  ) {
    super(app, inputEl)
  }

  getSuggestions(query: string): TFile[] {
    const fuzzy = prepareFuzzySearch(query)
    return this.app.vault.getMarkdownFiles()
      .filter(f => fuzzy(f.path) !== null)
      .sort((a, b) => {
        const sa = fuzzy(a.path)?.score ?? -Infinity
        const sb = fuzzy(b.path)?.score ?? -Infinity
        return sb - sa
      })
      .slice(0, 20)
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ cls: 'suggestion-title', text: file.basename })
    if (file.parent && file.parent.path !== '/') {
      el.createDiv({ cls: 'suggestion-note', text: file.parent.path })
    }
  }

  selectSuggestion(file: TFile): void {
    this.close()
    this.onChoose(file)
  }
}

// ---------------------------------------------------------------------------
// Single-field prompt modal (shared by menu actions)
// ---------------------------------------------------------------------------

class PromptModal extends Modal {
  private input!: HTMLInputElement

  constructor(
    app: App,
    private readonly title: string,
    private readonly label: string,
    private readonly placeholder: string,
    private readonly initial: string,
    private readonly onConfirm: (value: string) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText(this.title)
    const { contentEl } = this

    new Setting(contentEl)
      .setName(this.label)
      .addText(text => {
        this.input = text.inputEl
        text.setPlaceholder(this.placeholder)
        text.setValue(this.initial)
        this.input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') this.confirm()
          if (e.key === 'Escape') this.close()
        })
      })

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText('Apply').setCta().onClick(() => this.confirm()))
  }

  private confirm(): void {
    const val = this.input.value.trim()
    this.close()
    if (val) this.onConfirm(val)
  }

  onClose(): void { this.contentEl.empty() }
}

// ---------------------------------------------------------------------------
// File picker modal (used by the 3-dots menu)
// ---------------------------------------------------------------------------

class FilePickerModal extends Modal {
  private input!: HTMLInputElement
  private selected: TFile[] = []
  private listEl!: HTMLElement

  constructor(
    app: App,
    private readonly onConfirm: (files: TFile[]) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Add source files')
    const { contentEl } = this

    this.listEl = contentEl.createDiv({ cls: 'directive-file-picker__chips' })
    this.renderChips()

    new Setting(contentEl)
      .setName('File')
      .addText(text => {
        this.input = text.inputEl
        text.setPlaceholder('Search notes…')
        new FileSuggest(this.app, this.input, (file) => {
          if (!this.selected.find(f => f.path === file.path)) {
            this.selected.push(file)
            this.renderChips()
          }
          this.input.value = ''
          this.input.focus()
        })
        this.input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Escape') this.close()
        })
      })

    new Setting(contentEl)
      .addButton(btn => btn.setButtonText('Add sources').setCta().onClick(() => this.confirm()))
  }

  private renderChips(): void {
    this.listEl.empty()
    for (const file of this.selected) {
      const chip = this.listEl.createDiv({ cls: 'directive-file-picker__chip' })
      chip.createSpan({ text: file.basename })
      const removeBtn = chip.createEl('button', { cls: 'directive-file-picker__chip-remove clickable-icon' })
      setIcon(removeBtn, 'x')
      removeBtn.addEventListener('click', () => {
        this.selected = this.selected.filter(f => f.path !== file.path)
        this.renderChips()
      })
    }
  }

  private confirm(): void {
    if (this.selected.length > 0) this.onConfirm(this.selected)
    this.close()
  }

  onClose(): void { this.contentEl.empty() }
}

// ---------------------------------------------------------------------------
// ChecklistWidget
// ---------------------------------------------------------------------------

class ChecklistWidget extends DirectiveWidget {
  private cleanups: Array<() => void> = []
  private page = 0

  constructor(
    private readonly directive: ParsedDirective,
    private readonly app: App,
  ) {
    super()
  }

  eq(other: ChecklistWidget): boolean {
    if (!(other instanceof ChecklistWidget)) return false
    return (
      this.directive.attributes['from']     === other.directive.attributes['from'] &&
      this.directive.attributes['filter']   === other.directive.attributes['filter'] &&
      this.directive.attributes['group']    === other.directive.attributes['group'] &&
      this.directive.attributes['where']    === other.directive.attributes['where'] &&
      this.directive.attributes['pageSize'] === other.directive.attributes['pageSize'] &&
      this.directive.body                   === other.directive.body &&
      this.directive.label                  === other.directive.label
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const outer = activeDocument.createDiv()
    outer.className = 'directive-checklist__outer'

    outer.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    void this.buildContent(outer, view)
    return outer
  }

  toHeaderDOM(view: EditorView): HTMLElement {
    const header = this.buildHeaderEl(view)
    header.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })
    return header
  }

  toBodyDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createDiv()
    wrap.className = 'directive-widget directive-widget--checklist directive-widget--body-only'

    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    void this.buildBodyContent(wrap, view)
    return wrap
  }

  private insertInlineTask(view: EditorView): void {
    // Insert "- [ ] \n" just before the closing ::: fence.
    // directive.body includes everything between the fences (without trailing newline
    // before the fence), so bodyStart + body.length lands at the start of the closing fence.
    const openingLine = view.state.doc.lineAt(this.directive.from)
    const bodyStart   = openingLine.to + 1
    const bodyLen     = this.directive.body?.length ?? 0
    const insertPos   = bodyStart + bodyLen
    const insert      = '- [ ] \n'
    view.dispatch({
      changes: { from: insertPos, insert },
      selection: { anchor: insertPos + insert.length - 1 },
    })
    view.focus()
  }

  private buildHeaderEl(view: EditorView): HTMLElement {
    const label      = this.directive.label
    const filterAttr = (this.directive.attributes['filter'] ?? 'all') as FilterMode
    const grouped    = this.directive.attributes['group'] === 'true'

    const header = activeDocument.createDiv()
    header.className = 'directive-checklist__header'

    const title = activeDocument.createSpan()
    title.className = 'directive-checklist__title'
    title.textContent = label ?? 'Checklist'
    header.appendChild(title)

    const actions = activeDocument.createSpan()
    actions.className = 'directive-checklist__actions'

    const filterLabels: Record<FilterMode, string> = { all: 'All', todo: 'To do', done: 'Done' }
    const filterIcons:  Record<FilterMode, string> = { all: 'list', todo: 'circle', done: 'check-circle' }
    const currentFilter = (['todo', 'done', 'all'] as const).includes(filterAttr) ? filterAttr : 'all'
    const filterBtn = activeDocument.createEl('button')
    filterBtn.className = 'clickable-icon directive-checklist__action-btn directive-checklist__filter-btn'
    filterBtn.setAttribute('aria-label', `Filter: ${filterLabels[currentFilter]}`)
    filterBtn.dataset['filter'] = currentFilter
    setIcon(filterBtn, 'list-filter')
    const filterBadge = activeDocument.createSpan()
    filterBadge.className = 'directive-checklist__filter-badge'
    filterBadge.textContent = filterLabels[currentFilter]
    filterBtn.appendChild(filterBadge)
    filterBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    filterBtn.addEventListener('click', (e: MouseEvent) => {
      const menu = new Menu()
      ;(['all', 'todo', 'done'] as FilterMode[]).forEach(mode => {
        menu.addItem(item =>
          item
            .setTitle(filterLabels[mode])
            .setIcon(filterIcons[mode])
            .setChecked(currentFilter === mode)
            .onClick(() => setDirectiveAttr(view, this.directive, 'filter', mode === 'all' ? null : mode))
        )
      })
      menu.showAtMouseEvent(e)
    })
    actions.appendChild(filterBtn)

    const addBtn = activeDocument.createEl('button')
    addBtn.className = 'clickable-icon directive-checklist__action-btn'
    addBtn.setAttribute('aria-label', 'Add task')
    setIcon(addBtn, 'plus')
    addBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    addBtn.addEventListener('click', () => this.insertInlineTask(view))
    actions.appendChild(addBtn)

    const moreBtn = activeDocument.createEl('button')
    moreBtn.className = 'clickable-icon directive-checklist__action-btn'
    moreBtn.setAttribute('aria-label', 'More options')
    setIcon(moreBtn, 'more-horizontal')
    moreBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    moreBtn.addEventListener('click', (e: MouseEvent) => {
      const menu = new Menu()

      menu.addItem(item =>
        item
          .setTitle(grouped ? 'Ungroup tasks' : 'Group by source')
          .setIcon('layers')
          .onClick(() => setDirectiveAttr(view, this.directive, 'group', grouped ? null : 'true'))
      )

      menu.addSeparator()

      const currentLabel = this.directive.label ?? ''
      menu.addItem(item =>
        item
          .setTitle(currentLabel ? `Label: ${currentLabel}` : 'Set label…')
          .setIcon('tag')
          .onClick(() => {
            new PromptModal(
              this.app,
              'Set label',
              'Label',
              'e.g. Work Tasks',
              currentLabel,
              val => setDirectiveLabel(view, this.directive, val || null),
            ).open()
          })
      )

      menu.addSeparator()

      const currentPageSize = this.directive.attributes['pageSize'] ?? ''
      menu.addItem(item =>
        item
          .setTitle(currentPageSize ? `Page size: ${currentPageSize}` : 'Set page size…')
          .setIcon('list-ordered')
          .onClick(() => {
            new PromptModal(
              this.app,
              'Set page size',
              'Tasks per page',
              'e.g. 10',
              currentPageSize,
              val => {
                const n = parseInt(val, 10)
                if (n > 0) {
                  this.page = 0
                  setDirectiveAttr(view, this.directive, 'pageSize', String(n))
                }
              },
            ).open()
          })
      )

      const currentWhere = this.directive.attributes['where'] ?? ''
      menu.addItem(item =>
        item
          .setTitle(currentWhere ? `Where: ${currentWhere}` : 'Set frontmatter filter…')
          .setIcon('filter')
          .onClick(() => {
            new PromptModal(
              this.app,
              'Set frontmatter filter',
              'Filter expression',
              'e.g. status=active or type=project|task',
              currentWhere,
              val => setDirectiveAttr(view, this.directive, 'where', val),
            ).open()
          })
      )

      menu.addItem(item =>
        item
          .setTitle('Add file source…')
          .setIcon('file-plus')
          .onClick(() => {
            new FilePickerModal(this.app, (files) => {
              for (const file of files) addSourcePath(view, this.directive, file.path)
            }).open()
          })
      )

      menu.addItem(item =>
        item
          .setTitle('Add tag source…')
          .setIcon('tag')
          .onClick(() => {
            new PromptModal(
              this.app,
              'Add tag source',
              'Tag',
              'e.g. #project or project',
              '',
              val => {
                const tag = val.startsWith('#') ? val : `#${val}`
                addSourcePath(view, this.directive, tag)
              },
            ).open()
          })
      )

      if (currentPageSize) {
        menu.addSeparator()
        menu.addItem(item =>
          item
            .setTitle('Remove page size')
            .setIcon('x')
            .onClick(() => {
              this.page = 0
              setDirectiveAttr(view, this.directive, 'pageSize', null)
            })
        )
      }
      if (currentWhere) {
        menu.addItem(item =>
          item
            .setTitle('Remove frontmatter filter')
            .setIcon('x')
            .onClick(() => setDirectiveAttr(view, this.directive, 'where', null))
        )
      }

      menu.showAtMouseEvent(e)
    })
    actions.appendChild(moreBtn)

    const editBtn = activeDocument.createEl('button')
    editBtn.className = 'clickable-icon directive-checklist__action-btn'
    editBtn.setAttribute('aria-label', 'Edit this block')
    setIcon(editBtn, 'code-2')
    editBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    editBtn.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })
    actions.appendChild(editBtn)

    header.appendChild(actions)
    return header
  }

  private async buildBodyContent(bodyEl: HTMLElement, view: EditorView): Promise<void> {
    for (const fn of this.cleanups) fn()
    this.cleanups = []
    bodyEl.empty()

    const fromAttr   = this.directive.attributes['from'] ?? ''
    const whereAttr  = this.directive.attributes['where'] ?? ''
    const filterAttr = (this.directive.attributes['filter'] ?? 'all') as FilterMode
    const filter     = (['todo', 'done', 'all'] as const).includes(filterAttr) ? filterAttr : 'all'
    const where      = parseWhere(whereAttr)
    const grouped    = this.directive.attributes['group'] === 'true'

    // Resolve source entries — each may be a file path or a #tag
    const sourceEntries = fromAttr
      ? fromAttr.split(',').map(s => s.trim()).filter(Boolean)
      : []

    // Gather tasks; also collect every file path we're watching for vault changes
    let allTasks: Task[] = []
    const watchedPaths = new Set<string>()

    for (const src of sourceEntries) {
      if (src.startsWith('#')) {
        const { tasks, filePaths } = await findTasksByTag(src, this.app, where)
        allTasks = allTasks.concat(tasks)
        filePaths.forEach(p => watchedPaths.add(p))
      } else {
        const file = resolveFile(src, this.app)
        if (!file) {
          allTasks.push({
            checked: false,
            text: `⚠ Could not resolve "${src}"`,
            sourcePath: null,
            checkboxOffset: 0,
            textOffset: 0,
            lineLength: 0,
            lineNumber: 0,
            directiveContext: null,
            directiveLabel: null,
          })
          continue
        }
        watchedPaths.add(file.path)
        const content = await this.app.vault.read(file)
        // Exclude tasks nested inside :::checklist blocks — they are captured
        // by the inline body pass and would otherwise appear twice when the
        // source file is the same file that hosts this directive.
        allTasks = allTasks.concat(
          parseTasks(content, file.path).filter(t => t.directiveContext !== 'checklist')
        )
      }
    }

    // Inline body tasks
    if (this.directive.body) {
      const bodyTasks = parseTasks(this.directive.body, null)
      const openingLine = view.state.doc.lineAt(this.directive.from)
      const bodyStart   = openingLine.to + 1
      for (const t of bodyTasks) {
        t.checkboxOffset     += bodyStart
        t.textOffset         += bodyStart
        t.sourcePath          = null
        t.directiveContext    = null
        t.directiveLabel      = null
      }
      allTasks = allTasks.concat(bodyTasks)
    }

    const filtered = applyFilter(allTasks, filter)

    if (filtered.length === 0) {
      const empty = activeDocument.createDiv()
      empty.className = 'directive-checklist__empty'
      if (filter !== 'all') {
        const msg = filter === 'todo' ? 'No open tasks' : 'No completed tasks'
        empty.textContent = msg
      } else {
        empty.textContent = 'Press'
        const kbd = activeDocument.createSpan()
        kbd.className = 'directive-checklist__empty-hint'
        kbd.textContent = '+'
        const rest = activeDocument.createTextNode(' to add your first task')
        empty.appendChild(kbd)
        empty.appendChild(rest)
      }
      bodyEl.appendChild(empty)
      return
    }

    // Pagination
    const pageSize = parseInt(this.directive.attributes['pageSize'] ?? '0', 10) || 0
    const totalPages = pageSize > 0 ? Math.ceil(filtered.length / pageSize) : 1
    this.page = Math.max(0, Math.min(this.page, totalPages - 1))
    const paginated = pageSize > 0
      ? filtered.slice(this.page * pageSize, (this.page + 1) * pageSize)
      : filtered

    if (grouped && sourceEntries.length > 0) {
      const groups = new Map<string, Task[]>()
      for (const task of paginated) {
        const key = task.sourcePath ?? ''
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(task)
      }

      for (const [srcPath, tasks] of groups) {
        const section = activeDocument.createDiv()
        section.className = 'directive-checklist__group'

        if (srcPath) {
          const groupHeader = activeDocument.createDiv()
          groupHeader.className = 'directive-checklist__group-header'
          const parts = srcPath.split('/')
          groupHeader.textContent = (parts[parts.length - 1] ?? srcPath).replace(/\.md$/, '')
          section.appendChild(groupHeader)
        }

        const list = activeDocument.createDiv()
        list.className = 'directive-checklist__list'
        for (const task of tasks) {
          list.appendChild(this.buildRow(task, bodyEl, view, true))
        }
        section.appendChild(list)
        bodyEl.appendChild(section)
      }
    } else {
      const list = activeDocument.createDiv()
      list.className = 'directive-checklist__list'
      for (const task of paginated) {
        list.appendChild(this.buildRow(task, bodyEl, view, false))
      }
      bodyEl.appendChild(list)
    }

    // Pagination footer
    if (totalPages > 1) {
      const footer = activeDocument.createDiv()
      footer.className = 'directive-checklist__pagination'

      const prevBtn = activeDocument.createEl('button')
      prevBtn.className = 'clickable-icon directive-checklist__page-btn'
      prevBtn.disabled = this.page === 0
      setIcon(prevBtn, 'chevron-left')
      prevBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      prevBtn.addEventListener('click', () => {
        this.page = Math.max(0, this.page - 1)
        void this.buildBodyContent(bodyEl, view)
      })

      const pageLabel = activeDocument.createSpan()
      pageLabel.className = 'directive-checklist__page-label'
      pageLabel.textContent = `${this.page + 1} / ${totalPages}`

      const nextBtn = activeDocument.createEl('button')
      nextBtn.className = 'clickable-icon directive-checklist__page-btn'
      nextBtn.disabled = this.page >= totalPages - 1
      setIcon(nextBtn, 'chevron-right')
      nextBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      nextBtn.addEventListener('click', () => {
        this.page = Math.min(totalPages - 1, this.page + 1)
        void this.buildBodyContent(bodyEl, view)
      })

      footer.appendChild(prevBtn)
      footer.appendChild(pageLabel)
      footer.appendChild(nextBtn)
      bodyEl.appendChild(footer)
    }

    const onModify = (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return
      if (watchedPaths.has(file.path)) void this.buildBodyContent(bodyEl, view)
    }
    const hasTagSource = sourceEntries.some(s => s.startsWith('#'))
    const modRef = this.app.vault.on('modify', onModify)
    this.cleanups.push(() => this.app.vault.offref(modRef))
    if (hasTagSource) {
      const debouncedRebuild = debounce(() => { void this.buildBodyContent(bodyEl, view) }, 300)
      const cacheRef = this.app.metadataCache.on('changed', debouncedRebuild)
      this.cleanups.push(() => this.app.metadataCache.offref(cacheRef))
    }
  }

  private async buildContent(outer: HTMLElement, view: EditorView): Promise<void> {
    outer.empty()
    outer.appendChild(this.buildHeaderEl(view))
    const card = activeDocument.createDiv()
    card.className = 'directive-widget directive-widget--checklist'
    card.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    outer.appendChild(card)
    const bodyEl = activeDocument.createDiv()
    card.appendChild(bodyEl)
    await this.buildBodyContent(bodyEl, view)
  }

  private buildRow(task: Task, wrap: HTMLElement, view: EditorView, showCtxBadge = false): HTMLElement {
    const row = activeDocument.createDiv()
    row.className = 'directive-checklist__row'

    row.addEventListener('mousedown', (e: MouseEvent) => {
      e.stopPropagation()
    })

    // Checkbox
    const cb = activeDocument.createEl('input')
    cb.type      = 'checkbox'
    cb.checked   = task.checked
    cb.className = 'directive-checklist__checkbox'
    cb.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    cb.addEventListener('change', () => {
      void this.toggleTask(task, cb.checked, wrap, view)
    })

    // Task text
    const textEl = activeDocument.createSpan()
    textEl.className = 'directive-checklist__text'
    if (task.checked) textEl.classList.add('directive-checklist__text--done')
    textEl.textContent = task.text
    textEl.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    // Directive context badge (e.g. "Log") — shown when grouped by page
    if (showCtxBadge && task.directiveContext && task.directiveContext !== 'checklist') {
      const badge = activeDocument.createSpan()
      badge.className = 'directive-checklist__ctx-badge'
      const ctx = task.directiveLabel ?? task.directiveContext
      badge.textContent = ctx.charAt(0).toUpperCase() + ctx.slice(1)
      textEl.appendChild(badge)
    }

    // Row action buttons (edit + jump) — hidden until row hover
    const rowActions = activeDocument.createSpan()
    rowActions.className = 'directive-checklist__row-actions'

    const editBtn = activeDocument.createEl('button')
    editBtn.className = 'clickable-icon directive-checklist__row-btn'
    editBtn.setAttribute('aria-label', 'Edit task')
    setIcon(editBtn, 'pencil')
    editBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    editBtn.addEventListener('click', () => this.makeEditable(textEl, task, wrap, view))

    const jumpBtn = activeDocument.createEl('button')
    jumpBtn.className = 'clickable-icon directive-checklist__row-btn'
    jumpBtn.setAttribute('aria-label', 'Jump to source')
    setIcon(jumpBtn, 'arrow-right')
    jumpBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    jumpBtn.addEventListener('click', () => void this.jumpToTask(task, view))

    rowActions.appendChild(editBtn)
    rowActions.appendChild(jumpBtn)

    row.appendChild(cb)
    row.appendChild(textEl)
    row.appendChild(rowActions)
    return row
  }

  private async jumpToTask(task: Task, view: EditorView): Promise<void> {
    if (task.sourcePath === null) {
      // Inline task — move cursor to the start of that line in the current editor
      const lineStart = task.checkboxOffset - 3 // position of the leading "- "
      view.dispatch({ selection: { anchor: lineStart } })
      view.focus()
    } else {
      const file = this.app.vault.getAbstractFileByPath(task.sourcePath)
      if (!(file instanceof TFile)) return
      const leaf = this.app.workspace.getLeaf(false)
      await leaf.openFile(file, { eState: { line: task.lineNumber } })
    }
  }

  private async toggleTask(task: Task, newChecked: boolean, bodyEl: HTMLElement, view: EditorView): Promise<void> {
    task.checked = newChecked
    if (task.sourcePath === null) {
      // Inline body — write via CM dispatch; vault modify event won't fire, so rebuild manually.
      const replacement = newChecked ? 'x' : ' '
      view.dispatch({
        changes: { from: task.checkboxOffset, to: task.checkboxOffset + 1, insert: replacement },
      })
      void this.buildBodyContent(bodyEl, view)
    } else {
      // External file — vault modify event will fire and trigger buildContent via the watcher.
      const file = this.app.vault.getAbstractFileByPath(task.sourcePath)
      if (!(file instanceof TFile)) return
      const content = await this.app.vault.read(file)
      const updated = content.slice(0, task.checkboxOffset) +
        (newChecked ? 'x' : ' ') +
        content.slice(task.checkboxOffset + 1)
      await this.app.vault.modify(file, updated)
    }
  }

  private makeEditable(
    textEl: HTMLElement,
    task: Task,
    bodyEl: HTMLElement,
    view: EditorView,
  ): void {
    const input = activeDocument.createEl('input')
    input.type      = 'text'
    input.value     = task.text
    input.className = 'directive-checklist__edit-input'

    textEl.replaceWith(input)
    input.focus()
    input.select()

    input.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())

    const commit = async () => {
      const newText = input.value.trim()
      if (newText === task.text || !newText) {
        void this.buildBodyContent(bodyEl, view)
        return
      }
      if (task.sourcePath === null) {
        // Inline — dispatch CM change; rebuild manually since no vault event fires.
        view.dispatch({
          changes: { from: task.textOffset, to: task.textOffset + task.text.length, insert: newText },
        })
        void this.buildBodyContent(bodyEl, view)
      } else {
        // External file — vault modify event triggers the rebuild.
        const file = this.app.vault.getAbstractFileByPath(task.sourcePath)
        if (file instanceof TFile) {
          const content = await this.app.vault.read(file)
          const updated = content.slice(0, task.textOffset) + newText + content.slice(task.textOffset + task.text.length)
          await this.app.vault.modify(file, updated)
        }
      }
    }

    let cancelled = false
    input.addEventListener('blur', () => { if (!cancelled) void commit() })
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); void commit() }
      if (e.key === 'Escape') { cancelled = true; void this.buildBodyContent(bodyEl, view) }
    })
  }

  destroy(_dom: HTMLElement): void {
    for (const fn of this.cleanups) fn()
    this.cleanups = []
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createChecklistHandler(app: App): DirectiveHandler {
  return {
    name: 'checklist',

    render(directive: ParsedDirective, _state: EditorState): DirectiveWidget {
      return new ChecklistWidget(directive, app)
    },

    getInsertionBody(): string {
      return ''
    },
  }
}
