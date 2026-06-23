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

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { EditorSelection, EditorState, RangeSetBuilder, StateField, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'

import type { ParsedDirective } from '../types'
import type { DirectiveRegistry } from './registry'
import { directivesField } from './parser'
import { eventBusField } from './event-bus'

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
          if (line.from === fromLine.from && handler.buildActionWidget) {
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

      builder.add(from, to, Decoration.replace({ widget, block: true }))
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
      // Rebuild when document content or cursor selection changes.
      // Otherwise, map existing decoration positions through document changes.
      if (tr.docChanged || tr.selection !== undefined) {
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
