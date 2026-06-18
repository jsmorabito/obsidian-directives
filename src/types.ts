import type { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'

// ---------------------------------------------------------------------------
// Parsed directive shape — produced by the parser, consumed by handlers
// ---------------------------------------------------------------------------

export type DirectiveType = 'text' | 'leaf' | 'container'

export interface ParsedDirective {
  /** Syntactic form: inline text (:), leaf block (::), or container (:::). */
  type: DirectiveType
  /** Directive name, e.g. "audio", "youtube", "chords". */
  name: string
  /** Optional label inside []. */
  label: string | undefined
  /** Key/value attributes from {}. Shortcuts #id → id=, .cls → class=. */
  attributes: Record<string, string>
  /** Raw Markdown body (container directives only). */
  body: string | undefined
  /** Start offset in the editor document. */
  from: number
  /** End offset in the editor document (inclusive of closing fence). */
  to: number
}

// ---------------------------------------------------------------------------
// DirectiveWidget — base class handlers must extend
// ---------------------------------------------------------------------------

/**
 * The object a handler's `render()` returns.
 *
 * Extends CodeMirror's WidgetType so it can be handed directly to
 * `Decoration.replace()`. Handlers override `toDOM()` to build their UI,
 * and optionally `eq()` to skip unnecessary rebuilds.
 */
export abstract class DirectiveWidget extends WidgetType {
  /**
   * Build and return the DOM element for this directive.
   * Called by CodeMirror when the widget enters the viewport.
   *
   * REQUIRED CONVENTION: every implementation must attach a `mousedown`
   * listener that dispatches the cursor to `directive.from` so the
   * block StateField removes the decoration and reveals raw Markdown:
   *
   *   el.addEventListener('mousedown', (e) => {
   *     e.preventDefault()
   *     view.dispatch({ selection: { anchor: directive.from } })
   *     view.focus()
   *   })
   *
   * Without this, WidgetType.ignoreEvent() swallows all mouse events and
   * the user can never enter the block to edit it.
   */
  abstract toDOM(view: EditorView): HTMLElement

  /**
   * Called by CodeMirror before re-rendering. Return true if `other`
   * represents the same visual state (so the existing DOM can be reused).
   * Default: always re-render.
   */
  eq(_other: WidgetType): boolean {
    return false
  }

  /**
   * Called when the DOM element is removed from the editor.
   * Override to cancel timers, revoke URLs, disconnect observers, etc.
   */
  destroy(_dom: HTMLElement): void {
    // no-op by default
  }
}

// ---------------------------------------------------------------------------
// DirectiveHandler interface — what each built-in (and third-party) handler
// must implement
// ---------------------------------------------------------------------------

export interface DirectiveHandler {
  /** The directive name this handler claims, e.g. "audio". */
  readonly name: string

  /**
   * Called when a directive of this type needs a widget.
   *
   * Receives EditorState (not EditorView) because block decorations must
   * be produced by a StateField in Obsidian's CM6 build, which has no
   * access to the view. View-dependent work (DOM creation, event listeners,
   * audio element setup) belongs in DirectiveWidget.toDOM(view), which
   * CM6 calls later with the full EditorView.
   *
   * The EventBus is reachable here via state.field(eventBusField).
   */
  render(directive: ParsedDirective, state: EditorState): DirectiveWidget

  /**
   * Called when the directive's attributes or body change while the widget
   * is already in the viewport.
   *
   * Return an updated DirectiveWidget to replace the old one, or null to
   * trigger a full re-render via render().
   */
  update?(
    widget: DirectiveWidget,
    directive: ParsedDirective,
    state: EditorState,
  ): DirectiveWidget | null

  /**
   * Called when the directive leaves the viewport or the file is closed.
   * Use to cancel subscriptions, stop audio, etc.
   */
  destroy?(widget: DirectiveWidget): void

  /**
   * Optional: return the initial body text to insert when this directive is
   * selected from the autocomplete suggest.  The returned string is placed
   * between the opening fence and the blank cursor line.
   *
   * Example — a log handler returning "## Log\n" produces:
   *   :::log
   *   ## Log
   *   [cursor]
   *   :::
   *
   * Omit (or return "") for no pre-filled body.
   */
  getInsertionBody?(): string
}

// ---------------------------------------------------------------------------
// Built-in event bus payload types
// ---------------------------------------------------------------------------

export interface AudioPlayPayload   { src: string; time: number }
export interface AudioPausePayload  { src: string; time: number }
export interface AudioTimePayload   { src: string; time: number }
export interface AudioSeekPayload   { src: string; time: number }

export interface YouTubeTimePayload { vid: string; time: number }
export interface YouTubeSeekPayload { vid: string; time: number }

/** Union of all known event names → payload types. */
export interface DirectiveEventMap {
  'audio:play':        AudioPlayPayload
  'audio:pause':       AudioPausePayload
  'audio:timeupdate':  AudioTimePayload
  'audio:seek':        AudioSeekPayload
  'youtube:timeupdate': YouTubeTimePayload
  'youtube:seek':      YouTubeSeekPayload
}

/** A string that is a known event name or any namespaced custom event. */
export type DirectiveEventName = keyof DirectiveEventMap | (string & {})

/** Resolve payload type for a known event; fall back to unknown. */
export type DirectiveEventPayload<K extends DirectiveEventName> =
  K extends keyof DirectiveEventMap ? DirectiveEventMap[K] : unknown
