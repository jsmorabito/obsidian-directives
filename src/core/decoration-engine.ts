/**
 * decoration-engine.ts
 *
 * Obsidian's CM6 build forbids block decorations from ViewPlugin
 * ("Block decorations may not be specified via plugins"). The engine
 * is therefore split into two parts:
 *
 *   blockDecorationsField  — StateField<DecorationSet>
 *     Handles leaf (::) and container (:::) directives.
 *     Provided to the editor via EditorView.decorations.from(field).
 *     Has EditorState but NOT EditorView; handlers receive EditorState.
 *     Handlers do view-dependent work (DOM, audio, etc.) in widget.toDOM(view).
 *
 *   inlineDecorationsPlugin — ViewPlugin
 *     Handles text (:) directives.
 *     block: false decorations are allowed from ViewPlugin.
 *
 * Public API:
 *
 *   createDirectiveExtension(registry) → Extension
 *
 * Includes: directivesField, eventBusField, blockDecorationsField,
 *           inlineDecorationsPlugin.
 */

import { setIcon } from 'obsidian'
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { foldedRanges, foldEffect as cmFoldEffect, unfoldEffect as cmUnfoldEffect } from '@codemirror/language'

import type { ParsedDirective } from '../types'
import type { DirectiveRegistry } from './registry'
import { directivesField } from './parser'
import { eventBusField } from './event-bus'

// ---------------------------------------------------------------------------
// Fold-state store — survives widget re-renders within a session
// keyed by directive.from (document offset of the opening fence)
// ---------------------------------------------------------------------------

const foldState = new Map<number, boolean>() // true = collapsed

const FOLD_STORAGE_KEY = 'obsidian-directives:fold'

function foldPersistKey(d: ParsedDirective): string {
  return `${d.name}:${d.label ?? ''}:${d.from}`
}

function loadFoldState(d: ParsedDirective): boolean {
  try {
    const raw = localStorage.getItem(FOLD_STORAGE_KEY)
    if (!raw) return false
    const store = JSON.parse(raw) as Record<string, boolean>
    return store[foldPersistKey(d)] ?? false
  } catch { return false }
}

function saveFoldState(d: ParsedDirective, collapsed: boolean): void {
  try {
    const raw = localStorage.getItem(FOLD_STORAGE_KEY)
    const store: Record<string, boolean> = raw ? JSON.parse(raw) : {}
    if (collapsed) {
      store[foldPersistKey(d)] = true
    } else {
      delete store[foldPersistKey(d)]
    }
    localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify(store))
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Fold mechanism — CM6-native approach
//
// Foldable directives are split into two decorations:
//   1. Non-block Decoration.replace() on the opening line → FoldIndicatorWidget
//      This keeps the opening line as a real .cm-line element, letting us inject
//      the fold button as an inline child — same mechanism as Obsidian heading folds.
//   2. Block Decoration.replace() on the body+closing → the inner widget (or empty when collapsed)
// ---------------------------------------------------------------------------

export const foldEffect = StateEffect.define<{ from: number; collapsed: boolean }>()

// Inline widget that replaces the opening `:::directive` line text.
// If the inner widget exposes toHeaderDOM(), it renders the header here on the
// opening .cm-line with the fold button to the left. Otherwise it renders a
// zero-height span that just hosts the fold button in the left margin.
class FoldIndicatorWidget extends WidgetType {
  private readonly collapsed: boolean

  constructor(
    private readonly directive: ParsedDirective,
    private readonly inner: WidgetType | null = null,
  ) {
    super()
    this.collapsed = foldState.get(directive.from) ?? loadFoldState(directive)
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof FoldIndicatorWidget)) return false
    if (other.directive.from !== this.directive.from) return false
    if (other.collapsed !== this.collapsed) return false
    if (this.inner === null && other.inner === null) return true
    if (this.inner === null || other.inner === null) return false
    return this.inner.eq(other.inner)
  }

  private makeFoldBtn(view: EditorView): HTMLElement {
    const btn = activeDocument.createElement('span')
    btn.className = 'directive-foldable__toggle'
    if (this.collapsed) btn.classList.add('directive-foldable__toggle--collapsed')
    setIcon(btn, 'right-triangle')
    btn.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const nowCollapsed = !btn.classList.contains('directive-foldable__toggle--collapsed')
      foldState.set(this.directive.from, nowCollapsed)
      saveFoldState(this.directive, nowCollapsed)
      // Capture the header's screen Y so we can compensate if the fold changes layout above it.
      const coordsBefore = view.coordsAtPos(this.directive.from)
      view.dispatch({ effects: foldEffect.of({ from: this.directive.from, collapsed: nowCollapsed }) })
      if (coordsBefore) {
        requestAnimationFrame(() => {
          const coordsAfter = view.coordsAtPos(this.directive.from)
          if (coordsAfter) {
            const delta = coordsAfter.top - coordsBefore.top
            if (Math.abs(delta) > 1) view.scrollDOM.scrollTop += delta
          }
        })
      }
    })
    return btn
  }

  toDOM(view: EditorView): HTMLElement {
    const inner = this.inner as (WidgetType & { toHeaderDOM?: (v: EditorView) => HTMLElement }) | null

    if (inner?.toHeaderDOM) {
      // Render header inline on the opening line, fold button to the left
      const wrap = activeDocument.createElement('span')
      wrap.className = 'directive-fold-header'
      wrap.contentEditable = 'false'
      wrap.appendChild(this.makeFoldBtn(view))
      wrap.appendChild(inner.toHeaderDOM(view))
      return wrap
    }

    // Fallback: zero-height span, fold button only
    const el = activeDocument.createElement('span')
    el.className = 'directive-fold-indicator'
    el.contentEditable = 'false'
    el.appendChild(this.makeFoldBtn(view))
    return el
  }
}

// Wraps the inner widget and adds the collapsed class when folded,
// so CSS can hide the body content while keeping the header visible.
class FoldableBodyWidget extends WidgetType {
  constructor(
    private readonly inner: WidgetType,
    private readonly directive: ParsedDirective,
    private readonly collapsed: boolean,
  ) { super() }

  eq(other: WidgetType): boolean {
    return (
      other instanceof FoldableBodyWidget &&
      other.directive.from === this.directive.from &&
      other.collapsed === this.collapsed &&
      this.inner.eq(other.inner)
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const inner = this.inner as WidgetType & { toBodyDOM?: (v: EditorView) => HTMLElement }
    if (inner.toBodyDOM) {
      if (this.collapsed) {
        const empty = activeDocument.createElement('div')
        empty.style.display = 'none'
        return empty
      }
      return inner.toBodyDOM(view)
    }
    const el = this.inner.toDOM(view)
    if (this.collapsed) el.classList.add('directive-foldable--collapsed')
    return el
  }

  destroy(dom: HTMLElement): void {
    this.inner.destroy(dom)
  }
}

// ---------------------------------------------------------------------------
// Fallback widget — rendered for unrecognized directive names
// ---------------------------------------------------------------------------

class FallbackWidget extends WidgetType {
  constructor(private readonly directive: ParsedDirective) {
    super()
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof FallbackWidget &&
      other.directive.name === this.directive.name &&
      other.directive.from === this.directive.from
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement('div')
    wrap.className = 'directive-widget directive-widget--fallback'
    wrap.setAttribute('data-directive', this.directive.name)

    const badge = activeDocument.createElement('span')
    badge.className = 'directive-widget__name'
    badge.textContent = `:${this.directive.name}`
    wrap.appendChild(badge)

    if (this.directive.body) {
      const body = activeDocument.createElement('div')
      body.className = 'directive-widget__body'
      body.textContent = this.directive.body
      wrap.appendChild(body)
    }

    // Convention for ALL directive widgets:
    // Clicking the widget must move the cursor to directive.from so the
    // block StateField sees cursor-inside → removes the decoration →
    // raw Markdown becomes visible for editing.
    // WidgetType.ignoreEvent() returns true by default, so CM6 will never
    // move the cursor on its own — the widget must dispatch the selection.
    wrap.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      view.dispatch({ selection: { anchor: this.directive.from } })
      view.focus()
    })

    return wrap
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** True if the given position falls inside any CM6 folded range. */
function posInFold(state: EditorState, pos: number): boolean {
  let inside = false
  const cursor = foldedRanges(state).iter()
  while (cursor.value !== null) {
    if (pos >= cursor.from && pos <= cursor.to) { inside = true; break }
    cursor.next()
  }
  return inside
}

/** True if any cursor selection overlaps [from, to]. */
function cursorOverlaps(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  for (const sel of state.selection.ranges) {
    if (sel.from <= to && sel.to >= from) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Block decoration builder  (StateField — leaf + container directives)
// ---------------------------------------------------------------------------

function buildBlockDecorations(
  state: EditorState,
  registry: DirectiveRegistry,
): DecorationSet {
  try {
    const directives = state.field(directivesField, false)
    if (!directives || directives.length === 0) return Decoration.none

    const builder = new RangeSetBuilder<Decoration>()
    const ordered = [...directives]
      .filter(d => d.type !== 'text')
      .sort((a, b) => a.from - b.from)

    // Prune stale entries from the in-memory fold cache (directives removed/moved).
    const activeFroms = new Set(ordered.map(d => d.from))
    for (const key of foldState.keys()) {
      if (!activeFroms.has(key)) foldState.delete(key)
    }

    // Let each handler prune its own per-position state.
    const handlerActiveFroms = new Map<string, Set<number>>()
    for (const d of ordered) {
      const h = registry.get(d.name)
      if (!h?.pruneState) continue
      if (!handlerActiveFroms.has(d.name)) handlerActiveFroms.set(d.name, new Set())
      handlerActiveFroms.get(d.name)!.add(d.from)
    }
    for (const [name, froms] of handlerActiveFroms) {
      registry.get(name)?.pruneState?.(froms)
    }

    for (const directive of ordered) {
      // Snap to exact CM6 line boundaries — required for block: true.
      const fromLine = state.doc.lineAt(directive.from)
      const toLine   = state.doc.lineAt(Math.max(directive.to - 1, directive.from))
      const from     = fromLine.from
      const to       = toLine.to
      if (from >= to) continue

      const handler = registry.get(directive.name)

      if (handler?.decorateInPlace) {
        // In-place mode: text stays visible and editable, no widget replacement.
        // Apply Decoration.line() classes to every line in the directive range.
        // IMPORTANT: all builder.add() calls must be in ascending position order.
        let pos = from
        let hintPlaced = false
        while (pos <= to) {
          const line = state.doc.lineAt(pos)
          const isFence = line.from === fromLine.from || line.from === toLine.from
          builder.add(line.from, line.from, Decoration.line({
            class: isFence
              ? `directive-inplace directive-inplace-fence directive-inplace--${handler.name}`
              : `directive-inplace directive-inplace-body directive-inplace--${handler.name}`,
          }))
          // Action widget goes at end of opening fence line, right after its
          // line decoration (must be added here to maintain ascending order).
          if (line.from === fromLine.from && handler.buildActionWidget && !posInFold(state, fromLine.from)) {
            try {
              const actionWidget = handler.buildActionWidget(directive, state)
              if (actionWidget) {
                builder.add(fromLine.to, fromLine.to, Decoration.widget({ widget: actionWidget, side: 1 }))
              }
            } catch (err) {
              console.error(`[obsidian-directives] handler "${directive.name}" buildActionWidget() threw:`, err)
            }
          }
          // Hint widget: placed at the start of the first non-heading body line
          // so it appears at normal text size (not heading size).
          if (
            !hintPlaced &&
            handler.buildHintWidget &&
            line.from > fromLine.to &&
            line.from < toLine.from &&
            !line.text.trimStart().startsWith('#')
          ) {
            try {
              const hintWidget = handler.buildHintWidget(directive, state)
              if (hintWidget) {
                builder.add(line.from, line.from, Decoration.widget({ widget: hintWidget, side: -1 }))
                hintPlaced = true
              }
            } catch (err) {
              console.error(`[obsidian-directives] handler "${directive.name}" buildHintWidget() threw:`, err)
            }
          }
          if (line.to >= state.doc.length) break
          pos = line.to + 1
        }
        continue
      }

      if (cursorOverlaps(state, directive.from, directive.to)) continue

      let widget: WidgetType

      if (handler) {
        try {
          widget = handler.render(directive, state)
        } catch (err) {
          console.error(`[obsidian-directives] handler "${directive.name}" render() threw:`, err)
          widget = new FallbackWidget(directive)
        }
      } else {
        widget = new FallbackWidget(directive)
      }

      const hasSplit = typeof (widget as unknown as Record<string, unknown>)['toHeaderDOM'] === 'function'
      if (hasSplit) {
        // Widget supports split rendering: header on the opening .cm-line, body as block below.
        const openingLine = state.doc.lineAt(from)
        const bodyStart = openingLine.to + 1
        const collapsed = foldState.get(from) ?? loadFoldState(directive)

        builder.add(from, openingLine.to, Decoration.replace({ widget: new FoldIndicatorWidget(directive, widget) }))

        if (bodyStart <= to) {
          builder.add(bodyStart, to, Decoration.replace({ widget: new FoldableBodyWidget(widget, directive, collapsed), block: true }))
        }
      } else {
        builder.add(from, to, Decoration.replace({ widget, block: true }))
      }
    }

    return builder.finish()
  } catch (err) {
    console.error('[obsidian-directives] buildBlockDecorations threw:', err)
    return Decoration.none
  }
}

// ---------------------------------------------------------------------------
// Inline decoration builder  (ViewPlugin — text directives)
// ---------------------------------------------------------------------------

function buildInlineDecorations(
  view: EditorView,
  registry: DirectiveRegistry,
): DecorationSet {
  try {
    const directives = view.state.field(directivesField, false)
    if (!directives) return Decoration.none

    const builder = new RangeSetBuilder<Decoration>()
    const ordered = [...directives]
      .filter(d => d.type === 'text')
      .sort((a, b) => a.from - b.from)

    for (const directive of ordered) {
      if (cursorOverlaps(view.state, directive.from, directive.to)) continue
      if (directive.from >= directive.to) continue

      const handler = registry.get(directive.name)
      let widget: WidgetType

      if (handler) {
        try {
          widget = handler.render(directive, view.state)
        } catch (err) {
          console.error(`[obsidian-directives] inline handler "${directive.name}" render() threw:`, err)
          continue
        }
      } else {
        // No fallback for unknown inline directives — leave raw markdown visible.
        continue
      }

      builder.add(directive.from, directive.to, Decoration.replace({ widget, block: false }))
    }

    return builder.finish()
  } catch (err) {
    console.error('[obsidian-directives] buildInlineDecorations threw:', err)
    return Decoration.none
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create the full CodeMirror Extension for the directive system.
 *
 * Returns an array of extensions:
 *  1. directivesField          — parses directives from the document (StateField)
 *  2. eventBusField            — per-view pub/sub bus (StateField)
 *  3. blockField               — block decorations (StateField, provided via EditorView.decorations)
 *  4. inlinePlugin             — inline text directive decorations (ViewPlugin)
 *
 * @param registry  The plugin's DirectiveRegistry (shared across all views).
 */
export function createDirectiveExtension(registry: DirectiveRegistry): Extension {
  // Block decorations must come from a StateField in Obsidian's CM6 build.
  const blockField = StateField.define<DecorationSet>({
    create(state: EditorState): DecorationSet {
      return buildBlockDecorations(state, registry)
    },

    update(decos: DecorationSet, tr: Transaction): DecorationSet {
      if (tr.docChanged || tr.selection !== undefined || tr.effects.some(e => e.is(foldEffect) || e.is(cmFoldEffect) || e.is(cmUnfoldEffect))) {
        return buildBlockDecorations(tr.state, registry)
      }
      return decos.map(tr.changes)
    },

    provide(f: StateField<DecorationSet>): Extension {
      return EditorView.decorations.from(f)
    },
  })

  // Inline (text) directive decorations — ViewPlugin is fine for block: false.
  const inlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet

      constructor(view: EditorView) {
        this.decorations = buildInlineDecorations(view, registry)
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildInlineDecorations(update.view, registry)
        }
      }
    },
    { decorations: (v) => v.decorations },
  )

  // TransactionFilter: when a selection-only transaction skips over a directive block
  // (cursor was on the line immediately before/after it and jumped past), redirect to d.from.
  // This runs inside CM6's state machine so it can't be bypassed by Obsidian's event layer.
  const directiveNavFilter = EditorState.transactionFilter.of(tr => {
    if (!tr.selection || tr.docChanged) return tr

    const oldHead = tr.startState.selection.main.head
    const newHead = tr.selection.main.head
    if (oldHead === newHead) return tr

    const directives = tr.startState.field(directivesField, false)
    if (!directives) return tr

    const doc      = tr.startState.doc
    const oldLine  = doc.lineAt(oldHead).number
    const newLine  = doc.lineAt(newHead).number

    for (const d of directives) {
      if (d.type === 'text') continue
      if (registry.get(d.name)?.decorateInPlace) continue
      if (cursorOverlaps(tr.startState, d.from, d.to)) continue

      const dFromLine = doc.lineAt(d.from).number
      const dToLine   = doc.lineAt(d.to).number

      // Skipped down: was on line just above directive, landed after it
      const skippedDown = oldLine === dFromLine - 1 && newLine > dToLine
      // Skipped up: was on line just below directive, landed before it
      const skippedUp   = oldLine === dToLine + 1   && newLine < dFromLine

      if (skippedDown || skippedUp) {
        return { selection: EditorSelection.cursor(d.from) }
      }
    }
    return tr
  })

  return [directivesField, eventBusField, blockField, inlinePlugin, directiveNavFilter]
}
