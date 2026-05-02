# Obsidian Directives — CLAUDE.md

Developer context for AI-assisted work on this codebase.

---

## What this is

An Obsidian (desktop-only) community plugin that renders **generic directives** in the
live editor using CodeMirror 6.  Directives are fenced Markdown blocks that map to
interactive widgets: audio players, chord diagrams, guitar tabs, and YouTube embeds.

The directive syntax follows the [CommonMark generic directives proposal](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444):

```
:name[label]{key=val}            ← text  (inline)
::name[label]{key=val}           ← leaf  (block, no body)
:::name[label]{key=val}          ← container (block with body)
body…
:::
```

---

## Commands

```bash
npm run build   # tsc type-check + esbuild production bundle → main.js
npm run dev     # esbuild watch mode (no type-check, inline sourcemap)
npm run lint    # ESLint
```

After every build, reload the plugin in Obsidian:
**⌘P → "Reload app without saving"**, or toggle the plugin off/on in Settings.

---

## Project layout

```
src/
  main.ts                   Plugin entry point + public API (ObsidianDirectivesAPI)
  settings.ts               DirectivesSettings interface + DEFAULT_SETTINGS
  api.ts                    Public type file — third-party authors copy this
  types.ts                  Shared interfaces: ParsedDirective, DirectiveHandler,
                            DirectiveWidget, DirectiveEventMap
  core/
    parser.ts               StateField<ParsedDirective[]>  — re-parses on every change
    registry.ts             DirectiveRegistry — maps names → handlers
    event-bus.ts            EventBus class + StateField<EventBus>
    decoration-engine.ts    CM6 extension factory (block StateField + inline ViewPlugin)
  handlers/
    audio.ts                :::audio  — local audio player with timestamp list
    chords.ts               :::chords — SVG chord-diagram grid
    tab.ts                  :::tab    — monospace tab with BPM playhead
    youtube.ts              :::youtube — YouTube iframe + timestamp list
  ui/
    settings-tab.ts         PluginSettingTab for Obsidian Settings panel
```

**Output files** (do not edit):
- `main.js` — the bundled plugin (loaded by Obsidian)
- `styles.css` — widget CSS (loaded by Obsidian, references Obsidian CSS vars)
- `manifest.json` — plugin metadata

---

## Critical architectural constraint

**Obsidian's CM6 build forbids `block: true` decorations from a ViewPlugin.**

Attempting it throws: `"Block decorations may not be specified via plugins"`.

The decoration engine is therefore split:

| Decoration type | Source | Reason |
|---|---|---|
| Block (`::`, `:::`) | `StateField` + `provide: f => EditorView.decorations.from(f)` | Only StateField may produce block decorations |
| Inline (`:`) | `ViewPlugin` | `block: false` is allowed from ViewPlugin |

`DirectiveHandler.render()` receives `EditorState` (not `EditorView`) because it is
called inside the StateField.  DOM/event work lives in `WidgetType.toDOM(view)`.

---

## Click-to-edit convention (REQUIRED in every widget)

`WidgetType.ignoreEvent()` returns `true` by default, so CM6 never moves the cursor
when a widget is clicked.  Without the following pattern the block cannot be edited:

```typescript
el.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault()
  view.dispatch({ selection: { anchor: directive.from } })
  view.focus()
})
```

Every `toDOM()` implementation must do this on its outermost element.  Interactive
child elements (buttons, scrubbers, timestamp rows) must call `e.stopPropagation()`
on their own `mousedown` handlers to prevent the cursor move from firing.

---

## Adding a new built-in handler

1. Create `src/handlers/my-handler.ts` — export `createMyHandler(): DirectiveHandler`.
2. The handler's `render()` creates and returns a class that extends `DirectiveWidget`.
3. Import and call in `src/main.ts` inside `onload()`:
   ```typescript
   this.addHandler(createMyHandler())
   ```
4. Add any new CSS classes to `styles.css` using only Obsidian CSS variables
   (`var(--interactive-accent)`, `var(--text-normal)`, etc.) — no hardcoded colours.
5. Run `npm run build` and reload Obsidian.

---

## Event bus

One `EventBus` instance per editor view, stored in `eventBusField` (a `StateField`).
Retrieve it in `render()` with `state.field(eventBusField)`.

Built-in events (all payloads in `types.ts → DirectiveEventMap`):

| Event | Payload | Who publishes | Who subscribes |
|---|---|---|---|
| `audio:play` | `{ src, time }` | audio widget | — |
| `audio:pause` | `{ src, time }` | audio widget | tab widget (mirrors play button) |
| `audio:timeupdate` | `{ src, time }` | audio widget (4–15 Hz) | chords, tab (highlight / playhead) |
| `audio:seek` | `{ src, time }` | audio widget on scrub; chords on card click | audio widget (seeks player); tab (snaps playhead) |
| `youtube:timeupdate` | `{ vid, time }` | youtube widget (polled 4 Hz) | youtube timestamp list |
| `youtube:seek` | `{ vid, time }` | youtube timestamp row click | youtube widget (seekTo) |

Use a namespaced prefix for custom events: `"myplugin:event"`.

---

## Audio handler details

- `HTMLAudioElement` instances are cached at **module level** in `AUDIO_CACHE`
  keyed by resource URL.  This lets playback survive widget recreation when the
  cursor enters/exits the block.
- `disposeAllAudio()` is called from `onunload()` to release all elements.
- The `seekingFromBus` flag on `AudioWidget` prevents the `seeked` DOM event
  from re-publishing `audio:seek` when the seek originated from the event bus,
  which would create an infinite loop.

---

## TypeScript notes

- `tsconfig.json` has `"noUncheckedIndexedAccess": true`.  Array/Map reads
  return `T | undefined`; always guard or use `??`.
- All `@codemirror/*` packages are `external` in esbuild — Obsidian provides
  them at runtime.  They are `devDependencies` only (for type information).
- The plugin class implements `ObsidianDirectivesAPI` from `src/api.ts`, so
  TypeScript enforces that the public surface stays in sync with the interface.

---

## Third-party handler API

External plugins access the directive system via:

```typescript
import { getDirectivesAPI } from './api'  // copied from src/api.ts

const api = getDirectivesAPI(this.app)
if (!api) return  // plugin not enabled

const unregister = api.addHandler({
  name: 'my-widget',            // must match /^[a-z][a-z0-9-]*$/
  render(directive, state) {
    const bus = state.field(api.eventBusField)
    return new MyWidget(directive, bus)
  }
})
this.register(unregister)       // auto-cleanup on their plugin's unload
```

`addHandler()` validates the handler name, warns on built-in overrides, and returns
an unregister function.  The Directives plugin also auto-unregisters all handlers on
its own unload.  `api.apiVersion` is `"1.0.0"` (SemVer).

---

## Settings

Stored in `data.json` (Obsidian's `loadData` / `saveData` API).
Schema defined in `src/settings.ts`.  Current keys:

| Key | Type | Default | Used by |
|---|---|---|---|
| `defaultBpm` | number | 120 | tab handler (fallback when `bpm=` absent) |
| `defaultCpb` | number | 2 | tab handler (fallback when `cpb=` absent) |
| `defaultChordLayout` | string | `'grid'` | chords handler (fallback when `layout=` absent) |
| `_version` | number | 2 | schema migration guard |

Settings are passed as a live object reference to handler factories; mutations
from the settings tab take effect on the next widget render without a reload.

---

## Known limitations / future work

- **Reading mode** — directives only render in the live editor (CM6 extensions).
  Switching to Reading view shows raw Markdown.  A `MarkdownPostProcessor` would
  be needed for each handler to support preview mode.
- **No Lezer grammar** — the parser is a hand-written line scanner (`core/parser.ts`).
  A proper Lezer grammar is deferred to v2 and would improve highlighting and
  incremental parsing performance.
- **YouTube polling** — `youtube:timeupdate` is driven by a 250 ms `setInterval`
  polling `getCurrentTime` via postMessage.  YouTube's IFrame API does not push
  time events natively.
- **Chord database** — ~45 chords covering common keys.  Custom chord definitions
  via the directive body are not yet supported.
