/**
 * ui/directive-suggest.ts
 *
 * EditorSuggest that fires when the user types one or more colons followed
 * by letters.  Shows all registered directive names that match the partial
 * input, then inserts the completed directive syntax on selection.
 *
 * Trigger examples:
 *   :au       → suggests "audio"
 *   ::ch      → suggests "chords"
 *   :::lo     → suggests "log"
 *   :::       → shows all directives
 */

import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from 'obsidian'
import type { DirectiveRegistry } from '../core/registry'

// Match one, two, or three leading colons followed by an optional partial name.
const TRIGGER_RE = /:{1,3}([a-z0-9-]*)$/

interface DirectiveSuggestionItem {
  name: string
  colons: string   // ":", "::", or ":::" — whatever the user typed
}

export class DirectiveSuggest extends EditorSuggest<DirectiveSuggestionItem> {
  constructor(
    app: App,
    private readonly registry: DirectiveRegistry,
  ) {
    super(app)
  }

  // ── Trigger ────────────────────────────────────────────────────────────────

  onTrigger(
    cursor: EditorPosition,
    editor: Editor,
    _file: TFile,
  ): EditorSuggestTriggerInfo | null {
    const lineBefore = editor.getLine(cursor.line).slice(0, cursor.ch)
    const match = TRIGGER_RE.exec(lineBefore)
    if (!match) return null

    return {
      start: { line: cursor.line, ch: cursor.ch - match[0].length },
      end: cursor,
      query: match[1] ?? '',
    }
  }

  // ── Suggestions ────────────────────────────────────────────────────────────

  getSuggestions(
    context: EditorSuggestContext,
  ): DirectiveSuggestionItem[] {
    const query = context.query.toLowerCase()

    // Re-derive how many colons the user typed from the full matched region.
    const fullMatch = TRIGGER_RE.exec(
      context.editor.getLine(context.start.line).slice(0, context.end.ch),
    )
    const colons = fullMatch ? fullMatch[0].replace(/[a-z0-9-]+$/, '') : ':::'

    return Array.from(this.registry.registeredNames())
      .filter(name => name.startsWith(query))
      .sort()
      .map(name => ({ name, colons }))
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  renderSuggestion(item: DirectiveSuggestionItem, el: HTMLElement): void {
    const row = el.createDiv({ cls: 'directive-suggest-row' })

    const colonsEl = row.createSpan({ cls: 'directive-suggest-colons' })
    colonsEl.textContent = item.colons

    const nameEl = row.createSpan({ cls: 'directive-suggest-name' })
    nameEl.textContent = item.name
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  selectSuggestion(
    item: DirectiveSuggestionItem,
    _evt: MouseEvent | KeyboardEvent,
  ): void {
    const context = this.context
    if (!context) return

    const { colons, name } = item
    const editor = context.editor

    if (colons === ':::') {
      // Container directive — insert opening + optional pre-filled body + blank line + closing fence.
      const bodyPrefix = this.registry.get(name)?.getInsertionBody?.() ?? ''
      const insertion = `:::${name}\n${bodyPrefix}\n:::`
      editor.replaceRange(insertion, context.start, context.end)

      // Cursor lands on the blank line between bodyPrefix and the closing fence.
      // bodyPrefix may contain N lines (one \n per line), so cursor is at line:
      //   start.line + 1 (:::name) + number-of-newlines-in-bodyPrefix
      const extraLines = bodyPrefix ? (bodyPrefix.match(/\n/g) ?? []).length : 0
      editor.setCursor({ line: context.start.line + 1 + extraLines, ch: 0 })
    } else {
      // Leaf (::) or inline (:) — just complete the name.
      const insertion = `${colons}${name}`
      editor.replaceRange(insertion, context.start, context.end)
      editor.setCursor({ line: context.start.line, ch: context.start.ch + insertion.length })
    }
  }
}
