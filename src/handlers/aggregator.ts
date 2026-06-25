/**
 * handlers/aggregator.ts
 *
 * Implements the :::aggregator directive — pulls arbitrary matching lines from
 * across the vault and displays them as a read-only list with jump-to-source.
 *
 * Single-tab syntax (existing):
 *   :::aggregator[Title]{from="#improvements" group=true}
 *   :::
 *
 * Multi-tab syntax:
 *   :::aggregator[My Tracker]
 *   ::tab[Improvements]{from="#improvements" not="#resolved"}
 *   ::tab[Bugs]{from="#bugs" filter=hide-done not="#resolved,#wontfix"}
 *   :::
 *
 * Shared attributes (single-tab on opening fence; per-tab on each ::tab line):
 *   from        — Comma-separated sources: #tag entries or vault file paths.
 *   group       — "true" to group results by source file.
 *   paginate    — "true" to enable pagination.
 *   page-size   — Results per page (default: 25).
 *   where       — Frontmatter filter, e.g. where="status=active".
 *   strip-tags  — "true" to remove matched #tags from display text.
 *   filter      — "all" | "hide-done" | "only-done" (default: "all").
 *   not         — Comma-separated tags to permanently exclude.
 */

import { App, TAbstractFile, TFile, setIcon } from 'obsidian'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

import { DirectiveWidget } from '../types'
import type { DirectiveHandler, ParsedDirective } from '../types'
import { parseWhere, matchesFrontmatter, resolveFile, debounce } from '../core/utils'
import type { WhereCondition } from '../core/utils'
import { parseAttributes } from '../core/parser'

const DEFAULT_PAGE_SIZE = 25

// ---------------------------------------------------------------------------
// Done detection
// ---------------------------------------------------------------------------

const DONE_CHECKBOX_RE = /^- \[[xX]\] /
const STRIKETHROUGH_RE = /~~.+~~/

function isDone(text: string): boolean {
  return DONE_CHECKBOX_RE.test(text) || STRIKETHROUGH_RE.test(text)
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------

function buildTagRe(tag: string): RegExp {
  const normalized = tag.startsWith('#') ? tag : `#${tag}`
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?=[\\s,;.!?\\])]|$)`, 'i')
}

function parseNotTags(notAttr: string): RegExp[] {
  return notAttr.split(',').map(s => s.trim()).filter(Boolean).map(buildTagRe)
}

function isExcluded(text: string, notTagRes: RegExp[]): boolean {
  return notTagRes.some(re => re.test(text))
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

type FilterMode = 'all' | 'hide-done' | 'only-done'

export function applyFilter(lines: AggLine[], filter: FilterMode): AggLine[] {
  if (filter === 'hide-done') return lines.filter(l => !isDone(l.text))
  if (filter === 'only-done') return lines.filter(l =>  isDone(l.text))
  return lines
}

// ---------------------------------------------------------------------------
// Line model
// ---------------------------------------------------------------------------

interface AggLine {
  text: string
  sourcePath: string
  lineNumber: number
  offset: number
}

// ---------------------------------------------------------------------------
// Tab definition — parsed from ::tab lines in the body
// ---------------------------------------------------------------------------

interface TabDef {
  label: string
  attrs: Record<string, string>
}

const TAB_LINE_RE = /^::tab(?:\[([^\]]*)\])?(?:\{([^}]*)\})?/

export function parseTabDefs(body: string): TabDef[] {
  const tabs: TabDef[] = []
  for (const line of body.split('\n')) {
    const m = TAB_LINE_RE.exec(line.trim())
    if (!m) continue
    tabs.push({
      label: m[1]?.trim() || 'Tab',
      attrs: parseAttributes(m[2] ?? ''),
    })
  }
  return tabs
}

// ---------------------------------------------------------------------------
// Line collection
// ---------------------------------------------------------------------------

function tagRegex(tag: string): RegExp {
  const normalized = tag.startsWith('#') ? tag : `#${tag}`
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?=[\\s,;.!?\\])]|$)`, 'i')
}

export function collectMatchingLines(content: string, sourcePath: string, re: RegExp): AggLine[] {
  const lines: AggLine[] = []
  let offset = 0
  let lineNumber = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && re.test(line)) lines.push({ text: trimmed, sourcePath, lineNumber, offset })
    offset += line.length + 1
    lineNumber++
  }
  return lines
}

async function findLinesByTag(
  tag: string,
  app: App,
  where: WhereCondition[],
): Promise<{ lines: AggLine[]; filePaths: string[] }> {
  const normalized = tag.startsWith('#') ? tag : `#${tag}`
  const re = tagRegex(normalized)
  const filePaths: string[] = []
  const lines: AggLine[] = []
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file)
    if (!cache?.tags) continue
    const fileHasTag = cache.tags.some(
      t => t.tag.toLowerCase() === normalized.toLowerCase() ||
           t.tag.toLowerCase().startsWith(normalized.toLowerCase() + '/'),
    )
    if (!fileHasTag) continue
    if (!matchesFrontmatter(cache.frontmatter, where)) continue
    filePaths.push(file.path)
    const content = await app.vault.read(file)
    lines.push(...collectMatchingLines(content, file.path, re))
  }
  return { lines, filePaths }
}

async function findLinesInFile(file: TFile, app: App): Promise<AggLine[]> {
  const content = await app.vault.read(file)
  const lines: AggLine[] = []
  let offset = 0
  let lineNumber = 0
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) lines.push({ text: trimmed, sourcePath: file.path, lineNumber, offset })
    offset += line.length + 1
    lineNumber++
  }
  return lines
}

// ---------------------------------------------------------------------------
// Collect lines for a given attribute set
// ---------------------------------------------------------------------------

async function collectLines(
  attrs: Record<string, string>,
  app: App,
): Promise<{ lines: AggLine[]; watchedPaths: Set<string>; hasTagSource: boolean }> {
  const fromAttr  = attrs['from'] ?? ''
  const whereAttr = attrs['where'] ?? ''
  const stripTags = attrs['strip-tags'] === 'true'
  const notTagRes = parseNotTags(attrs['not'] ?? '')
  const filterAttr = (attrs['filter'] ?? 'all') as FilterMode
  const filter: FilterMode = (['all', 'hide-done', 'only-done'] as const).includes(filterAttr) ? filterAttr : 'all'
  const where = parseWhere(whereAttr)

  const sourceEntries = fromAttr.split(',').map(s => s.trim()).filter(Boolean)
  const watchedPaths = new Set<string>()
  let hasTagSource = false
  let allLines: AggLine[] = []

  for (const src of sourceEntries) {
    if (src.startsWith('#')) {
      hasTagSource = true
      const { lines, filePaths } = await findLinesByTag(src, app, where)
      const displayLines = stripTags
        ? lines.map(l => ({ ...l, text: l.text.replace(tagRegex(src), '').replace(/\s{2,}/g, ' ').trim() }))
        : lines
      allLines = allLines.concat(displayLines)
      filePaths.forEach(p => watchedPaths.add(p))
    } else {
      const file = resolveFile(src, app)
      if (!file) {
        allLines.push({ text: `⚠ Could not resolve "${src}"`, sourcePath: '', lineNumber: 0, offset: 0 })
        continue
      }
      watchedPaths.add(file.path)
      allLines = allLines.concat(await findLinesInFile(file, app))
    }
  }

  const withoutExcluded = notTagRes.length ? allLines.filter(l => !isExcluded(l.text, notTagRes)) : allLines
  return { lines: applyFilter(withoutExcluded, filter), watchedPaths, hasTagSource }
}

// ---------------------------------------------------------------------------
// Attribute write-back helpers
// ---------------------------------------------------------------------------

function applyAttrChange(
  view: EditorView,
  lineFrom: number,
  lineText: string,
  key: string,
  value: string | null,
): void {
  const braceMatch = /\{([^}]*)\}/.exec(lineText)
  if (!braceMatch) {
    if (value !== null) {
      const quoted = /[\s,]/.test(value) ? `"${value}"` : value
      view.dispatch({ changes: { from: lineFrom + lineText.length, insert: `{${key}=${quoted}}` } })
    }
    return
  }
  const braceFrom = lineFrom + (braceMatch.index ?? 0)
  const braceTo   = braceFrom + braceMatch[0].length
  let inner = (braceMatch[1] ?? '')
    .replace(new RegExp(`\\s*\\b${key}=(?:"[^"]*"|\\S+)`), '')
    .trim()
  if (value !== null) {
    const quoted = /[\s,]/.test(value) ? `"${value}"` : value
    inner = inner ? `${inner} ${key}=${quoted}` : `${key}=${quoted}`
  }
  view.dispatch({ changes: { from: braceFrom, to: braceTo, insert: inner ? `{${inner}}` : '' } })
}

/** Edit an attribute on the directive's opening fence line. */
function setDirectiveAttr(
  view: EditorView,
  directive: ParsedDirective,
  key: string,
  value: string | null,
): void {
  const line = view.state.doc.lineAt(directive.from)
  applyAttrChange(view, line.from, line.text, key, value)
}

/** Edit an attribute on a specific ::tab line (0-based tabIndex) in the body. */
function setTabAttr(
  view: EditorView,
  directive: ParsedDirective,
  tabIndex: number,
  key: string,
  value: string | null,
): void {
  // Walk document lines from the line after the opening fence, counting ::tab matches.
  const openingLine = view.state.doc.lineAt(directive.from)
  let lineNo = openingLine.number + 1
  let found  = 0
  while (lineNo <= view.state.doc.lines) {
    const line = view.state.doc.line(lineNo)
    if (TAB_LINE_RE.test(line.text.trim())) {
      if (found === tabIndex) {
        applyAttrChange(view, line.from, line.text, key, value)
        return
      }
      found++
    }
    lineNo++
  }
}

// ---------------------------------------------------------------------------
// Module-level result cache (stale-while-revalidate across widget instances)
// ---------------------------------------------------------------------------

interface CacheEntry {
  tabResults: AggLine[][]  // one AggLine[] per tab (length 1 for single-tab mode)
  watchedPaths: Set<string>
  hasTagSource: boolean
}

const aggregatorCache = new Map<string, CacheEntry>()

function makeCacheKey(directive: ParsedDirective, tabs: TabDef[]): string {
  if (tabs.length > 0) {
    return JSON.stringify(tabs.map(t => ({ label: t.label, attrs: t.attrs })))
  }
  return JSON.stringify({ attrs: directive.attributes, label: directive.label })
}

// ---------------------------------------------------------------------------
// AggregatorWidget
// ---------------------------------------------------------------------------

class AggregatorWidget extends DirectiveWidget {
  private cleanups: Array<() => void> = []

  // Single-tab state
  private currentPage = 0
  private cachedLines: AggLine[] = []

  // Multi-tab state
  private activeTab = 0
  private tabCaches: AggLine[][] = []
  private tabPages: number[] = []

  // Split-rendering refs (set by toHeaderDOM / toBodyDOM)
  private titleEl: HTMLElement | null = null
  private actionsEl: HTMLElement | null = null
  private bodyEl: HTMLElement | null = null

  constructor(
    private readonly directive: ParsedDirective,
    private readonly app: App,
  ) {
    super()
  }

  eq(other: AggregatorWidget): boolean {
    if (!(other instanceof AggregatorWidget)) return false
    return (
      this.directive.attributes['from']       === other.directive.attributes['from'] &&
      this.directive.attributes['group']      === other.directive.attributes['group'] &&
      this.directive.attributes['where']      === other.directive.attributes['where'] &&
      this.directive.attributes['strip-tags'] === other.directive.attributes['strip-tags'] &&
      this.directive.attributes['paginate']   === other.directive.attributes['paginate'] &&
      this.directive.attributes['page-size']  === other.directive.attributes['page-size'] &&
      this.directive.attributes['filter']     === other.directive.attributes['filter'] &&
      this.directive.attributes['not']        === other.directive.attributes['not'] &&
      this.directive.body                     === other.directive.body &&
      this.directive.label                    === other.directive.label
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('div')
    wrap.className = 'directive-checklist__outer'
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    const tabs = parseTabDefs(this.directive.body ?? '')
    const label = this.directive.label ?? 'Aggregator'
    const onRefresh = tabs.length > 0
      ? () => void this.buildTabbed(wrap, view, tabs)
      : () => void this.buildSingle(wrap, view)

    const header = this.buildHeader(label, view, onRefresh)
    this.titleEl   = header.querySelector('.directive-checklist__title') as HTMLElement
    this.actionsEl = header.querySelector('.directive-checklist__actions') as HTMLElement
    wrap.appendChild(header)

    const bodyEl = activeDocument.createElement('div')
    bodyEl.className = 'directive-widget directive-widget--aggregator'
    bodyEl.addEventListener('mousedown', (e: MouseEvent) => e.stopPropagation())
    wrap.appendChild(bodyEl)
    this.bodyEl = bodyEl

    void this.buildBodyContent(bodyEl, view)
    return wrap
  }

  toHeaderDOM(view: EditorView): HTMLElement {
    const tabs  = parseTabDefs(this.directive.body ?? '')
    const label = this.directive.label ?? 'Aggregator'
    const onRefresh = tabs.length > 0
      ? () => { if (this.bodyEl) void this.buildBodyContent(this.bodyEl, view) }
      : () => { if (this.bodyEl) void this.buildBodyContent(this.bodyEl, view) }

    const header = this.buildHeader(label, view, onRefresh)
    this.titleEl   = header.querySelector('.directive-checklist__title') as HTMLElement
    this.actionsEl = header.querySelector('.directive-checklist__actions') as HTMLElement

    if (tabs.length === 0) {
      this.buildActionButtons(
        this.actionsEl,
        this.directive.attributes,
        (key, value) => setDirectiveAttr(view, this.directive, key, value),
      )
    }

    header.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })
    return header
  }

  toBodyDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('div')
    wrap.className = 'directive-widget directive-widget--aggregator directive-widget--body-only'
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })
    this.bodyEl = wrap
    void this.buildBodyContent(wrap, view)
    return wrap
  }

  private async buildBodyContent(container: HTMLElement, view: EditorView): Promise<void> {
    for (const fn of this.cleanups) fn()
    this.cleanups = []

    const tabs = parseTabDefs(this.directive.body ?? '')
    if (tabs.length > 0) {
      await this.buildTabbed(container, view, tabs)
    } else {
      await this.buildSingle(container, view)
    }
  }

  // ── Single-tab mode (no ::tab lines in body) ────────────────────────────────

  // ── Single-tab mode ────────────────────────────────────────────────────────

  private async buildSingle(bodyEl: HTMLElement, view: EditorView): Promise<void> {
    const attrs    = this.directive.attributes
    const label    = this.directive.label ?? 'Aggregator'
    const grouped  = attrs['group'] === 'true'
    const paginate = attrs['paginate'] === 'true'
    const pageSize = Math.max(1, parseInt(attrs['page-size'] ?? '', 10) || DEFAULT_PAGE_SIZE)

    // In non-split mode (toDOM), bodyEl contains the header; add action buttons now.
    if (this.actionsEl) {
      // Remove any previously injected dynamic buttons (keep permanent refresh + edit).
      Array.from(this.actionsEl.children).forEach(child => {
        if (!(child as HTMLElement).dataset['permanent']) this.actionsEl!.removeChild(child)
      })
      this.buildActionButtons(
        this.actionsEl,
        attrs,
        (key, value) => setDirectiveAttr(view, this.directive, key, value),
      )
    }

    const sourceEntries = (attrs['from'] ?? '').split(',').map(s => s.trim()).filter(Boolean)

    // Clear body content (not the header — header is a sibling, not inside bodyEl).
    this.clearBodyContent(bodyEl)

    if (sourceEntries.length === 0) {
      bodyEl.appendChild(this.emptyEl('Add a from= attribute to pull lines (e.g. from="#improvements")'))
      return
    }

    // Render from cache immediately if available (stale-while-revalidate).
    const cacheKey = makeCacheKey(this.directive, [])
    const cached = aggregatorCache.get(cacheKey)
    if (cached) {
      this.cachedLines = cached.tabResults[0] ?? []
      if (this.titleEl) this.titleEl.textContent = `${label} (${this.cachedLines.length})`
      this.renderPage(bodyEl, view, grouped, sourceEntries, paginate, pageSize, 'single')
      this.setupWatchers(cached.watchedPaths, cached.hasTagSource, () => void this.buildSingle(bodyEl, view))
    }

    const { lines, watchedPaths, hasTagSource } = await collectLines(attrs, this.app)
    aggregatorCache.set(cacheKey, { tabResults: [lines], watchedPaths, hasTagSource })

    if (cached && lines.length === this.cachedLines.length &&
        lines.every((l, i) => l.text === (this.cachedLines[i]?.text ?? ''))) return

    this.cachedLines = lines
    if (this.titleEl) this.titleEl.textContent = `${label} (${lines.length})`
    this.renderPage(bodyEl, view, grouped, sourceEntries, paginate, pageSize, 'single')
    if (!cached) this.setupWatchers(watchedPaths, hasTagSource, () => void this.buildSingle(bodyEl, view))
  }

  // ── Multi-tab mode ──────────────────────────────────────────────────────────

  private async buildTabbed(bodyEl: HTMLElement, view: EditorView, tabs: TabDef[]): Promise<void> {
    this.activeTab = Math.min(this.activeTab, tabs.length - 1)
    this.tabCaches = Array.from({ length: tabs.length }, (): AggLine[] => [])
    this.tabPages  = Array.from({ length: tabs.length }, () => 0)

    const label = this.directive.label ?? 'Aggregator'

    // Rebuild header action buttons to match the active tab.
    const rebuildHeaderActions = () => {
      if (!this.actionsEl) return
      Array.from(this.actionsEl.children).forEach(child => {
        if (!(child as HTMLElement).dataset['permanent']) this.actionsEl!.removeChild(child)
      })
      this.buildActionButtons(
        this.actionsEl,
        tabs[this.activeTab]?.attrs ?? {},
        (key, value) => setTabAttr(view, this.directive, this.activeTab, key, value),
      )
    }
    rebuildHeaderActions()

    // Tab bar lives in the body.
    this.clearBodyContent(bodyEl)

    const tabBar = activeDocument.createElement('div')
    tabBar.className = 'directive-aggregator__tab-bar'
    tabBar.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })

    const tabBtns: HTMLButtonElement[] = []
    tabs.forEach((tab, idx) => {
      const btn = activeDocument.createElement('button')
      btn.className = 'directive-aggregator__tab-btn'
      btn.classList.toggle('is-active', idx === this.activeTab)
      btn.textContent = tab.label
      btn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      btn.addEventListener('click', () => {
        if (this.activeTab === idx) return
        this.activeTab = idx
        tabBtns.forEach((b, i) => b.classList.toggle('is-active', i === idx))
        rebuildHeaderActions()
        this.renderTabContent(bodyEl, view, tabs[idx]!, idx)
      })
      tabBtns.push(btn)
      tabBar.appendChild(btn)
    })
    bodyEl.appendChild(tabBar)

    const cacheKey = makeCacheKey(this.directive, tabs)
    const cached = aggregatorCache.get(cacheKey)
    if (cached) {
      tabs.forEach((tab, idx) => {
        this.tabCaches[idx] = cached.tabResults[idx] ?? []
        tabBtns[idx]!.textContent = `${tab.label} (${this.tabCaches[idx]?.length ?? 0})`
      })
      this.renderTabContent(bodyEl, view, tabs[this.activeTab]!, this.activeTab)
      this.setupWatchers(cached.watchedPaths, cached.hasTagSource, () => void this.buildTabbed(bodyEl, view, tabs))
    }

    const allWatchedPaths = new Set<string>()
    let hasTagSource = false
    const results = await Promise.all(tabs.map(tab => collectLines(tab.attrs, this.app)))
    results.forEach(({ lines, watchedPaths, hasTagSource: hts }, idx) => {
      this.tabCaches[idx] = lines
      watchedPaths.forEach(p => allWatchedPaths.add(p))
      if (hts) hasTagSource = true
    })

    aggregatorCache.set(cacheKey, { tabResults: this.tabCaches.map(c => [...c]), watchedPaths: allWatchedPaths, hasTagSource })

    tabBtns.forEach((btn, idx) => {
      const count = this.tabCaches[idx]?.length ?? 0
      btn.textContent = `${tabs[idx]!.label} (${count})`
    })

    if (this.titleEl) {
      const total = this.tabCaches.reduce((s, c) => s + c.length, 0)
      this.titleEl.textContent = `${label} (${total})`
    }

    const countUnchanged = cached && tabs.every((_, idx) =>
      (cached.tabResults[idx]?.length ?? -1) === (this.tabCaches[idx]?.length ?? 0))
    if (!countUnchanged) this.renderTabContent(bodyEl, view, tabs[this.activeTab]!, this.activeTab)

    if (!cached) this.setupWatchers(allWatchedPaths, hasTagSource, () => void this.buildTabbed(bodyEl, view, tabs))
  }

  private renderTabContent(bodyEl: HTMLElement, view: EditorView, tab: TabDef, idx: number): void {
    // Keep only the tab bar (first child), remove everything after it.
    while (bodyEl.children.length > 1) bodyEl.removeChild(bodyEl.lastChild!)

    const grouped  = tab.attrs['group'] === 'true'
    const paginate = tab.attrs['paginate'] === 'true'
    const pageSize = Math.max(1, parseInt(tab.attrs['page-size'] ?? '', 10) || DEFAULT_PAGE_SIZE)
    const sourceEntries = (tab.attrs['from'] ?? '').split(',').map(s => s.trim()).filter(Boolean)

    this.cachedLines = this.tabCaches[idx] ?? []
    this.currentPage = this.tabPages[idx] ?? 0

    if (this.cachedLines.length === 0) {
      bodyEl.appendChild(this.emptyEl('No matching lines found'))
      return
    }

    this.renderPage(bodyEl, view, grouped, sourceEntries, paginate, pageSize, `tab-${idx}`)
  }

  /** Clear body content — in single mode removes all children; in tabbed keeps the tab bar. */
  private clearBodyContent(bodyEl: HTMLElement): void {
    const hasTabBar = !!bodyEl.querySelector('.directive-aggregator__tab-bar')
    if (hasTabBar) {
      while (bodyEl.children.length > 1) bodyEl.removeChild(bodyEl.lastChild!)
    } else {
      bodyEl.empty()
    }
  }

  // ── Shared rendering ────────────────────────────────────────────────────────

  private renderPage(
    bodyEl: HTMLElement,
    view: EditorView,
    grouped: boolean,
    sourceEntries: string[],
    paginate: boolean,
    pageSize: number,
    pageKey: string,
  ): void {
    // Keep only the tab bar if present, then add list/pagination below it.
    const keepCount = bodyEl.querySelector('.directive-aggregator__tab-bar') ? 1 : 0
    while (bodyEl.children.length > keepCount) bodyEl.removeChild(bodyEl.lastChild!)

    const allLines   = this.cachedLines
    const totalPages = paginate ? Math.max(1, Math.ceil(allLines.length / pageSize)) : 1
    this.currentPage = Math.min(this.currentPage, totalPages - 1)

    const visibleLines = paginate
      ? allLines.slice(this.currentPage * pageSize, (this.currentPage + 1) * pageSize)
      : allLines

    if (allLines.length === 0) {
      bodyEl.appendChild(this.emptyEl('No matching lines found'))
      return
    }

    if (grouped && sourceEntries.length > 0) {
      const groups = new Map<string, AggLine[]>()
      for (const line of visibleLines) {
        if (!groups.has(line.sourcePath)) groups.set(line.sourcePath, [])
        groups.get(line.sourcePath)!.push(line)
      }
      for (const [srcPath, lines] of groups) {
        const section = activeDocument.createElement('div')
        section.className = 'directive-checklist__group'
        if (srcPath) {
          const gh = activeDocument.createElement('div')
          gh.className = 'directive-checklist__group-header'
          const parts = srcPath.split('/')
          gh.textContent = (parts[parts.length - 1] ?? srcPath).replace(/\.md$/, '')
          section.appendChild(gh)
        }
        const list = activeDocument.createElement('div')
        list.className = 'directive-checklist__list'
        for (const line of lines) list.appendChild(this.buildRow(line, view))
        section.appendChild(list)
        bodyEl.appendChild(section)
      }
    } else {
      const list = activeDocument.createElement('div')
      list.className = 'directive-checklist__list'
      for (const line of visibleLines) list.appendChild(this.buildRow(line, view))
      bodyEl.appendChild(list)
    }

    if (paginate && totalPages > 1) {
      const start = this.currentPage * pageSize + 1
      const end   = Math.min((this.currentPage + 1) * pageSize, allLines.length)

      const footer = activeDocument.createElement('div')
      footer.className = 'directive-aggregator__pagination'
      footer.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })

      const prevBtn = activeDocument.createElement('button')
      prevBtn.className = 'clickable-icon directive-checklist__action-btn directive-aggregator__page-btn'
      prevBtn.setAttribute('aria-label', 'Previous page')
      setIcon(prevBtn, 'chevron-left')
      prevBtn.disabled = this.currentPage === 0
      prevBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      prevBtn.addEventListener('click', () => {
        this.currentPage--
        this.syncTabPage()
        this.renderPage(bodyEl, view, grouped, sourceEntries, paginate, pageSize, pageKey)
      })

      const counter = activeDocument.createElement('span')
      counter.className = 'directive-aggregator__page-counter'
      counter.textContent = `${start}–${end} of ${allLines.length}`

      const nextBtn = activeDocument.createElement('button')
      nextBtn.className = 'clickable-icon directive-checklist__action-btn directive-aggregator__page-btn'
      nextBtn.setAttribute('aria-label', 'Next page')
      setIcon(nextBtn, 'chevron-right')
      nextBtn.disabled = this.currentPage >= totalPages - 1
      nextBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      nextBtn.addEventListener('click', () => {
        this.currentPage++
        this.syncTabPage()
        this.renderPage(bodyEl, view, grouped, sourceEntries, paginate, pageSize, pageKey)
      })

      footer.appendChild(prevBtn)
      footer.appendChild(counter)
      footer.appendChild(nextBtn)
      bodyEl.appendChild(footer)
    } else if (paginate) {
      const footer = activeDocument.createElement('div')
      footer.className = 'directive-aggregator__pagination'
      footer.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      const counter = activeDocument.createElement('span')
      counter.className = 'directive-aggregator__page-counter'
      counter.textContent = `${allLines.length} result${allLines.length === 1 ? '' : 's'}`
      footer.appendChild(counter)
      bodyEl.appendChild(footer)
    }
  }

  /** Keep tabPages in sync when navigating a paginated tab. */
  private syncTabPage(): void {
    if (this.tabPages.length > 0) this.tabPages[this.activeTab] = this.currentPage
  }

  // ── Shared helpers ──────────────────────────────────────────────────────────

  private buildHeader(titleText: string, view: EditorView, onRefresh: () => void): HTMLElement {
    const header = activeDocument.createElement('div')
    header.className = 'directive-checklist__header'
    header.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })

    const title = activeDocument.createElement('span')
    title.className = 'directive-checklist__title'
    title.textContent = titleText
    header.appendChild(title)

    const actions = activeDocument.createElement('span')
    actions.className = 'directive-checklist__actions'

    const refreshBtn = activeDocument.createElement('button')
    refreshBtn.className = 'clickable-icon directive-checklist__action-btn'
    refreshBtn.setAttribute('aria-label', 'Refresh')
    setIcon(refreshBtn, 'refresh-cw')
    refreshBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    refreshBtn.addEventListener('click', onRefresh)
    refreshBtn.dataset['permanent'] = '1'
    actions.appendChild(refreshBtn)

    const editBtn = activeDocument.createElement('button')
    editBtn.className = 'clickable-icon directive-checklist__action-btn'
    editBtn.setAttribute('aria-label', 'Edit this block')
    setIcon(editBtn, 'code-2')
    editBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    editBtn.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })
    editBtn.dataset['permanent'] = '1'
    actions.appendChild(editBtn)

    header.appendChild(actions)
    return header
  }

  /** Build group + filter + paginate action buttons, prepending them into `actions`. */
  private buildActionButtons(
    actions: HTMLElement,
    attrs: Record<string, string>,
    onAttrChange: (key: string, value: string | null) => void,
  ): void {
    const grouped  = attrs['group'] === 'true'
    const paginate = attrs['paginate'] === 'true'
    const filterAttr = (attrs['filter'] ?? 'all') as FilterMode
    const filter: FilterMode = (['all', 'hide-done', 'only-done'] as const).includes(filterAttr) ? filterAttr : 'all'

    // Group toggle
    const groupBtn = activeDocument.createElement('button')
    groupBtn.className = 'clickable-icon directive-checklist__action-btn'
    groupBtn.setAttribute('aria-label', grouped ? 'Ungroup results' : 'Group by source')
    setIcon(groupBtn, 'layers')
    groupBtn.classList.toggle('is-active', grouped)
    groupBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    groupBtn.addEventListener('click', () => onAttrChange('group', grouped ? null : 'true'))
    actions.insertBefore(groupBtn, actions.firstChild)

    // Filter cycle
    const filterCycle: FilterMode[] = ['all', 'hide-done', 'only-done']
    const filterLabels: Record<FilterMode, string> = { all: 'All', 'hide-done': 'Hide done', 'only-done': 'Only done' }
    const filterIcons:  Record<FilterMode, string> = { all: 'list', 'hide-done': 'circle', 'only-done': 'check-circle' }
    const filterBtn = activeDocument.createElement('button')
    filterBtn.className = 'clickable-icon directive-checklist__action-btn directive-checklist__filter-btn'
    filterBtn.setAttribute('aria-label', `Filter: ${filterLabels[filter]}`)
    setIcon(filterBtn, filterIcons[filter])
    const filterBadge = activeDocument.createElement('span')
    filterBadge.className = 'directive-checklist__filter-badge'
    filterBadge.textContent = filterLabels[filter]
    filterBtn.appendChild(filterBadge)
    filterBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    filterBtn.addEventListener('click', () => {
      const idx  = filterCycle.indexOf(filter)
      const next = filterCycle[(idx + 1) % filterCycle.length] ?? 'all'
      onAttrChange('filter', next === 'all' ? null : next)
    })
    actions.insertBefore(filterBtn, actions.firstChild)

    // Paginate toggle
    const paginateBtn = activeDocument.createElement('button')
    paginateBtn.className = 'clickable-icon directive-checklist__action-btn'
    paginateBtn.setAttribute('aria-label', paginate ? 'Disable pagination' : 'Enable pagination')
    setIcon(paginateBtn, 'book-open')
    paginateBtn.classList.toggle('is-active', paginate)
    paginateBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
    paginateBtn.addEventListener('click', () => onAttrChange('paginate', paginate ? null : 'true'))
    actions.insertBefore(paginateBtn, actions.firstChild)
  }

  private emptyEl(message: string): HTMLElement {
    const el = activeDocument.createElement('div')
    el.className = 'directive-checklist__empty'
    el.textContent = message
    return el
  }

  private buildRow(line: AggLine, view: EditorView): HTMLElement {
    const row = activeDocument.createElement('div')
    row.className = 'directive-checklist__row directive-aggregator__row'
    row.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })

    const textEl = activeDocument.createElement('span')
    textEl.className = 'directive-checklist__text directive-aggregator__text'
    textEl.textContent = line.text
    textEl.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })

    const rowActions = activeDocument.createElement('span')
    rowActions.className = 'directive-checklist__row-actions'

    if (line.sourcePath) {
      const jumpBtn = activeDocument.createElement('button')
      jumpBtn.className = 'clickable-icon directive-checklist__row-btn'
      jumpBtn.setAttribute('aria-label', 'Jump to source')
      setIcon(jumpBtn, 'arrow-right')
      jumpBtn.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); e.preventDefault() })
      jumpBtn.addEventListener('click', () => void this.jumpToLine(line))
      rowActions.appendChild(jumpBtn)
    }

    row.appendChild(textEl)
    row.appendChild(rowActions)
    return row
  }

  private async jumpToLine(line: AggLine): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(line.sourcePath)
    if (!(file instanceof TFile)) return
    const leaf = this.app.workspace.getLeaf(false)
    await leaf.openFile(file, { eState: { line: line.lineNumber } })
  }

  private setupWatchers(
    watchedPaths: Set<string>,
    hasTagSource: boolean,
    rebuild: () => void,
  ): void {
    const onModify = (file: TAbstractFile) => {
      if (file instanceof TFile && watchedPaths.has(file.path)) rebuild()
    }
    const modRef = this.app.vault.on('modify', onModify)
    this.cleanups.push(() => this.app.vault.offref(modRef))
    if (hasTagSource) {
      const debouncedRebuild = debounce(rebuild, 300)
      const cacheRef = this.app.metadataCache.on('changed', debouncedRebuild)
      this.cleanups.push(() => this.app.metadataCache.offref(cacheRef))
    }
  }

  destroy(_dom: HTMLElement): void {
    for (const fn of this.cleanups) fn()
    this.cleanups = []
  }
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createAggregatorHandler(app: App): DirectiveHandler {
  return {
    name: 'aggregator',

    render(directive: ParsedDirective, _state: EditorState): DirectiveWidget {
      return new AggregatorWidget(directive, app)
    },

    getInsertionBody(): string {
      return ''
    },
  }
}
