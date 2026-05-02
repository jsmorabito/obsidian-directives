/**
 * api.ts — Public API for Obsidian Directives
 *
 * Third-party plugin authors: copy this file into your project to get
 * full type safety when registering custom directive handlers.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Quick-start example
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   import { getDirectivesAPI } from './api'      // your copied file
 *   import { WidgetType }        from '@codemirror/view'
 *   import type { EditorView }   from '@codemirror/view'
 *
 *   class MyWidget extends WidgetType {
 *     constructor(private text: string) { super() }
 *
 *     toDOM(_view: EditorView): HTMLElement {
 *       const el = document.createElement('div')
 *       el.textContent = this.text
 *       return el
 *     }
 *
 *     eq(other: MyWidget): boolean { return this.text === other.text }
 *   }
 *
 *   // Inside your Plugin.onload():
 *   const api = getDirectivesAPI(this.app)
 *   if (!api) return   // Obsidian Directives is not installed/enabled
 *
 *   const unregister = api.addHandler({
 *     name: 'my-widget',
 *     render(directive, state) {
 *       const bus = state.field(api.eventBusField)
 *       // bus.subscribe / bus.publish for cross-handler events
 *       return new MyWidget(directive.label ?? 'Hello')
 *     },
 *   })
 *
 *   // When your plugin unloads (optional — Directives also cleans up):
 *   this.register(unregister)
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Directive syntax reference
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   Text (inline):    :name[label]{key=val}
 *   Leaf (block):    ::name[label]{key=val}
 *   Container:      :::name[label]{key=val}
 *                   body content
 *                   :::
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Compatibility
 * ──────────────────────────────────────────────────────────────────────────
 *
 *   Check `api.apiVersion` (SemVer) before using features introduced in
 *   later releases.  The current API is `1.0.0`.
 */

import type { App }          from 'obsidian'
import type { EditorState, StateField } from '@codemirror/state'
import type { WidgetType }   from '@codemirror/view'

// ---------------------------------------------------------------------------
// Re-exported types — everything a handler author needs
// ---------------------------------------------------------------------------

/**
 * The parsed form of a directive, produced by the core parser and passed to
 * every handler's render() call.
 */
export interface ParsedDirective {
  /** "text" = inline (:), "leaf" = block (::), "container" = fenced (:::). */
  type: 'text' | 'leaf' | 'container'
  /** Directive name, e.g. "audio", "my-widget". */
  name: string
  /** Content of the optional [label] part. */
  label: string | undefined
  /** Parsed {key=val} attributes. Shortcuts: #id → id=, .cls → class=. */
  attributes: Record<string, string>
  /** Raw body text (container directives only). */
  body: string | undefined
  /** Start offset in the document. */
  from: number
  /** End offset in the document (inclusive of closing fence). */
  to: number
}

/**
 * Minimal EventBus interface. The full implementation is in event-bus.ts;
 * this subset is sufficient for handler authors.
 *
 * Built-in event names:
 *   audio:play        { src: string; time: number }
 *   audio:pause       { src: string; time: number }
 *   audio:timeupdate  { src: string; time: number }
 *   audio:seek        { src: string; time: number }
 *   youtube:timeupdate { vid: string; time: number }
 *   youtube:seek       { vid: string; time: number }
 *
 * Use your own "myplugin:event" namespace for custom events.
 */
export interface DirectivesEventBus {
  publish(event: string, payload: unknown): void
  subscribe(event: string, callback: (payload: unknown) => void): () => void
}

/**
 * A directive handler.  Implement this interface and pass an instance to
 * api.addHandler().
 *
 * The render() function must return a WidgetType (from @codemirror/view).
 * Implement toDOM(view) on your widget to build the DOM element.
 *
 * IMPORTANT: every toDOM() implementation must attach a mousedown listener
 * that dispatches the cursor into the block, so the user can click to edit:
 *
 *   el.addEventListener('mousedown', (e) => {
 *     e.preventDefault()
 *     view.dispatch({ selection: { anchor: directive.from } })
 *     view.focus()
 *   })
 *
 * Without this, CodeMirror's WidgetType.ignoreEvent() swallows all mouse
 * events and the block becomes uneditable.
 */
export interface DirectiveHandler {
  /** Directive name this handler claims, e.g. "my-widget". Must be unique. */
  readonly name: string
  /**
   * Called when a directive of this name needs a widget.
   * Receives EditorState (not EditorView) because block decorations must be
   * produced by a StateField.  Do DOM/event work inside WidgetType.toDOM().
   */
  render(directive: ParsedDirective, state: EditorState): WidgetType
  /**
   * Called when the directive's content changes while already in the
   * viewport.  Return an updated widget, or null to trigger a full re-render.
   */
  update?(
    widget: WidgetType,
    directive: ParsedDirective,
    state: EditorState,
  ): WidgetType | null
  /** Called when the directive leaves the viewport or the file closes. */
  destroy?(widget: WidgetType): void
}

// ---------------------------------------------------------------------------
// Public plugin API
// ---------------------------------------------------------------------------

/**
 * The stable public API exposed by the Obsidian Directives plugin.
 *
 * Obtain an instance with getDirectivesAPI(app).
 */
export interface ObsidianDirectivesAPI {
  /**
   * Semantic version of this API surface (SemVer).
   * Check this before using features introduced in later releases.
   * Current version: "1.0.0".
   */
  readonly apiVersion: string

  /**
   * The EventBus CodeMirror StateField.
   * Retrieve the bus inside render() with: `state.field(api.eventBusField)`
   *
   * The bus is scoped per-editor-view so handlers on different notes do not
   * share events.  Use a namespaced event name, e.g. "myplugin:event".
   */
  readonly eventBusField: StateField<DirectivesEventBus>

  /**
   * Register a custom directive handler.
   *
   * Rules:
   *   - `name` must match /^[a-z][a-z0-9-]*$/ (lowercase, hyphens allowed).
   *   - Registering a name that already exists replaces the previous handler
   *     and logs a console warning.
   *   - Built-in names (audio, chords, tab, youtube) can be overridden but
   *     will also log a warning.
   *
   * Returns an unregister function.  You can pass it to Plugin.register()
   * so it runs on your plugin's unload, or call it manually.  The Directives
   * plugin will also automatically unregister all handlers on its own unload.
   */
  addHandler(handler: DirectiveHandler): () => void

  /** Return true if a handler is registered for the given directive name. */
  hasHandler(name: string): boolean

  /** Return the names of all currently registered handlers. */
  getHandlerNames(): string[]
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Retrieve the Obsidian Directives API from the host app.
 *
 * Returns null if the plugin is not installed or not currently enabled —
 * always guard against this in your onload():
 *
 *   const api = getDirectivesAPI(this.app)
 *   if (!api) {
 *     console.warn('Obsidian Directives is not enabled.')
 *     return
 *   }
 */
export function getDirectivesAPI(app: App): ObsidianDirectivesAPI | null {
  // Obsidian exposes enabled community plugins at app.plugins.plugins.
  // We cast through `any` because Obsidian's TS types don't model plugin
  // instances beyond the base Plugin class.
  const plugin = (app as unknown as Record<string, unknown>)['plugins'] as
    | { plugins: Record<string, unknown> }
    | undefined

  const instance = plugin?.plugins?.['obsidian-directives']
  if (!instance || typeof (instance as Record<string, unknown>)['addHandler'] !== 'function') {
    return null
  }
  return instance as unknown as ObsidianDirectivesAPI
}
