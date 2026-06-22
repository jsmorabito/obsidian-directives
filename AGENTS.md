# Obsidian Directives — agent context

## What this plugin does

**obsidian-directives** renders interactive widgets in the CM6 live editor using a
[generic directives](https://talk.commonmark.org/t/generic-directives-plugins-syntax/444) syntax
(`:name`, `::name`, `:::name`).  It is desktop-only.

### Built-in directive handlers

| Directive | File | What it renders |
|---|---|---|
| `:::audio` | `src/handlers/audio.ts` | Local audio player with a scrubber and timestamped note list |
| `:::chords` | `src/handlers/chords.ts` | SVG chord-diagram grid (~45 chords); syncs highlight to audio playhead |
| `:::tab` | `src/handlers/tab.ts` | Monospace guitar tab with a BPM-driven playhead |
| `:::youtube` | `src/handlers/youtube.ts` | YouTube iframe with timestamped note list |
| `:::log` | `src/handlers/log.ts` | Chronological activity log with "New entry" / date-picker buttons and a view-header popover |

### Core architecture

```
src/
  main.ts                   Plugin entry + public API (ObsidianDirectivesAPI)
  settings.ts               Settings interface + defaults
  api.ts                    Public type file for third-party plugins
  types.ts                  ParsedDirective, DirectiveHandler, DirectiveWidget, DirectiveEventMap
  core/
    parser.ts               StateField<ParsedDirective[]> — re-parses on every change
    registry.ts             DirectiveRegistry — maps names → handlers
    event-bus.ts            EventBus + StateField<EventBus>
    decoration-engine.ts    CM6 extension factory:
                              • block StateField → block decorations (::, :::)
                              • inline ViewPlugin → inline decorations (:)
  handlers/                 One file per directive (see table above)
  ui/
    settings-tab.ts         PluginSettingTab
    directive-suggest.ts    EditorSuggest for autocomplete
    add-to-log-modal.ts     Modal + insertNoteIntoLog() helper
    view-log-modal.ts       ViewLogPopover — view-header popover for :::log files
```

### Critical constraint: block decorations must come from a StateField

Obsidian's CM6 build throws `"Block decorations may not be specified via plugins"` if you try
to produce block decorations from a `ViewPlugin`.  The decoration engine is split:

- **Block** (`::`, `:::`) → `StateField` with `provide: f => EditorView.decorations.from(f)`
- **Inline** (`:`) → `ViewPlugin`

`DirectiveHandler.render()` receives `EditorState` (not `EditorView`) for this reason.

### Click-to-edit (required in every widget)

Every `toDOM()` outermost element must dispatch a cursor move on `mousedown` so the block
can be edited.  Interactive children must call `e.stopPropagation()` on their own `mousedown`.

```typescript
el.addEventListener('mousedown', (e: MouseEvent) => {
  e.preventDefault()
  view.dispatch({ selection: { anchor: directive.from } })
  view.focus()
})
```

### Event bus

One `EventBus` per editor view, stored in `eventBusField` (a `StateField`).
Retrieve in `render()` with `state.field(eventBusField)`.  Key events:
`audio:play`, `audio:pause`, `audio:timeupdate`, `audio:seek`, `youtube:timeupdate`, `youtube:seek`.

### Adding a new handler

1. Create `src/handlers/my-handler.ts`, export `createMyHandler(): DirectiveHandler`.
2. `render()` returns a class extending `DirectiveWidget`.
3. Register in `src/main.ts` `onload()`: `this.addHandler(createMyHandler())`.
4. Add CSS to `styles.css` using only Obsidian CSS variables (no hardcoded colours).
5. `npm run build` → reload Obsidian.

### Third-party handler API

External plugins call `getDirectivesAPI(app)` (from a copy of `src/api.ts`) and call
`api.addHandler(handler)`.  The returned unregister function should be passed to
`this.register(...)`.

### Settings (stored in `data.json`)

| Key | Type | Default |
|---|---|---|
| `defaultBpm` | number | 120 |
| `defaultCpb` | number | 2 |
| `defaultChordLayout` | string | `'grid'` |
| `logDateStyle` | string | `'plain'` |
| `logDateFormat` | string | `'{{date}}'` |
| `logDateHeadingLevel` | number | 0 |
| `logTitleHeadingLevel` | number | 0 |
| `_version` | number | 2 |

### TypeScript notes

- `"noUncheckedIndexedAccess": true` — array/Map reads return `T | undefined`; always guard.
- All `@codemirror/*` packages are `external` in esbuild (Obsidian provides them at runtime).
- The plugin class implements `ObsidianDirectivesAPI` from `src/api.ts`.

---

## Obsidian community plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Entry point: `main.ts` compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- **Package manager: npm** (required for this sample - `package.json` defines npm scripts and dependencies).
- **Bundler: esbuild** (required for this sample - `esbuild.config.mjs` and build scripts depend on it). Alternative bundlers like Rollup or webpack are acceptable for other projects if they bundle all external dependencies into `main.js`.
- Types: `obsidian` type definitions.

**Note**: This sample project has specific technical dependencies on npm and esbuild. If you're creating a plugin from scratch, you can choose different tools, but you'll need to replace the build configuration accordingly.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- **Organize code into multiple files**: Split functionality across separate modules rather than putting everything in `main.ts`.
- Source lives in `src/`. Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering commands).
- **Example file structure**:
  ```
  src/
    main.ts           # Plugin entry point, lifecycle management
    settings.ts       # Settings interface and defaults
    commands/         # Command implementations
      command1.ts
      command2.ts
    ui/              # UI components, modals, views
      modal.ts
      view.ts
    utils/           # Utility functions, helpers
      helpers.ts
      constants.ts
    types.ts         # TypeScript interfaces and types
  ```
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other generated files to version control.
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.
- Generated output should be placed at the plugin root or `dist/` depending on your build setup. Release artifacts must end up at the top level of the plugin folder in the vault (`main.js`, `manifest.json`, `styles.css`).

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):  
  - `id` (plugin ID; for local dev it should match the folder name)  
  - `name`  
  - `version` (Semantic Versioning `x.y.z`)  
  - `minAppVersion`  
  - `description`  
  - `isDesktopOnly` (boolean)  
  - Optional: `author`, `authorUrl`, `fundingUrl` (string or map)
- Never change `id` after release. Treat it as stable API.
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
  ```
  <Vault>/.obsidian/plugins/<plugin-id>/
  ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Commands & settings

- Any user-facing commands should be added via `this.addCommand(...)`.
- If the plugin has configuration, provide a settings tab and sensible defaults.
- Persist settings using `this.loadData()` / `this.saveData()`.
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as individual assets.
- After the initial release, follow the process to add/update your plugin in the community catalog as required.

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential to the feature.
- No hidden telemetry. If you collect optional analytics or call third-party services, require explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files outside the vault.
- Clearly disclose any external services used, data sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal information unless absolutely necessary and explicitly consented.
- Avoid deceptive patterns, ads, or spammy notifications.
- Register and clean up all DOM, app, and interval listeners using the provided `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations in response to file system events.

## Coding conventions

- TypeScript with `"strict": true` preferred.
- **Keep `main.ts` minimal**: Focus only on plugin lifecycle (onload, onunload, addCommand calls). Delegate all feature logic to separate modules.
- **Split large files**: If any file exceeds ~200-300 lines, consider breaking it into smaller, focused modules.
- **Use clear module boundaries**: Each file should have a single, well-defined responsibility.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly` accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**
- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.

**Don't**
- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit opt-in.
- Store or transmit vault contents unless essential and consented.

## Common tasks

### Organize code across multiple files

**main.ts** (minimal, lifecycle only):
```ts
import { Plugin } from "obsidian";
import { MySettings, DEFAULT_SETTINGS } from "./settings";
import { registerCommands } from "./commands";

export default class MyPlugin extends Plugin {
  settings: MySettings;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    registerCommands(this);
  }
}
```

**settings.ts**:
```ts
export interface MySettings {
  enabled: boolean;
  apiKey: string;
}

export const DEFAULT_SETTINGS: MySettings = {
  enabled: true,
  apiKey: "",
};
```

**commands/index.ts**:
```ts
import { Plugin } from "obsidian";
import { doSomething } from "./my-command";

export function registerCommands(plugin: Plugin) {
  plugin.addCommand({
    id: "do-something",
    name: "Do something",
    callback: () => doSomething(plugin),
  });
}
```

### Add a command

```ts
this.addCommand({
  id: "your-command-id",
  name: "Do the thing",
  callback: () => this.doTheThing(),
});
```

### Persist settings

```ts
interface MySettings { enabled: boolean }
const DEFAULT_SETTINGS: MySettings = { enabled: true };

async onload() {
  this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  await this.saveData(this.settings);
}
```

### Register listeners safely

```ts
this.registerEvent(this.app.workspace.on("file-open", f => { /* ... */ }));
this.registerDomEvent(window, "resize", () => { /* ... */ });
this.registerInterval(window.setInterval(() => { /* ... */ }, 1000));
```

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top level of the plugin folder under `<Vault>/.obsidian/plugins/<plugin-id>/`. 
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile your TypeScript source code.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: ensure `loadData`/`saveData` are awaited and you re-render the UI after changes.
- Mobile-only issues: confirm you're not using desktop-only APIs; check `isDesktopOnly` and adjust.

## References

- Obsidian sample plugin: https://github.com/obsidianmd/obsidian-sample-plugin
- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
- Generic directives proposal (CommonMark): https://talk.commonmark.org/t/generic-directives-plugins-syntax/444
- micromark directive extension (reference implementation): https://github.com/micromark/micromark-extension-directive
