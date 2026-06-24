import { MarkdownView, Plugin, TFile } from 'obsidian'
import { DirectiveRegistry } from './core/registry'
import { createDirectiveExtension } from './core/decoration-engine'
import { eventBusField } from './core/event-bus'
import { createAudioHandler, disposeAllAudio } from './handlers/audio'
import { createChordsHandler } from './handlers/chords'
import { createTabHandler } from './handlers/tab'
import { createYouTubeHandler } from './handlers/youtube'
import { createLogHandler } from './handlers/log'
import { createChecklistHandler } from './handlers/checklist'
import { createAggregatorHandler } from './handlers/aggregator'
import { DirectivesSettingTab } from './ui/settings-tab'
import { DirectiveSuggest } from './ui/directive-suggest'
import { AddToLogModal } from './ui/add-to-log-modal'
import { ViewLogPopover } from './ui/view-log-modal'
import { DEFAULT_SETTINGS } from './settings'
import type { DirectivesSettings } from './settings'
import type { DirectiveHandler } from './types'
import type { ObsidianDirectivesAPI } from './api'

/** Semantic version of the public handler API. Increment minor on additions,
 *  major on breaking changes to DirectiveHandler or ParsedDirective. */
export const API_VERSION = '1.0.0'

/** Directive names claimed by built-in handlers. */
const BUILTIN_NAMES = new Set(['audio', 'chords', 'tab', 'youtube', 'log', 'checklist', 'aggregator'])

/** Pattern a valid directive name must match. */
const VALID_NAME = /^[a-z][a-z0-9-]*$/

export default class ObsidianDirectivesPlugin extends Plugin
  implements ObsidianDirectivesAPI {

  // ── ObsidianDirectivesAPI ────────────────────────────────────────────────

  readonly apiVersion = API_VERSION

  /**
   * The EventBus StateField — exposed so third-party handlers can call
   * `state.field(api.eventBusField)` without importing eventBusField directly.
   */
  readonly eventBusField = eventBusField

  // ── Internal ─────────────────────────────────────────────────────────────

  registry!: DirectiveRegistry
  settings!: DirectivesSettings

  private logViewButtons = new WeakMap<MarkdownView, HTMLElement>()
  private openLogPopover: ViewLogPopover | null = null
  private fontStyleEl: HTMLStyleElement | null = null

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DirectivesSettings>)

    this.registry = new DirectiveRegistry()

    // Built-in handlers — spec build order §10.8
    this.addHandler(createAudioHandler(this.app))
    this.addHandler(createChordsHandler(this.settings))
    this.addHandler(createTabHandler(this.settings))
    this.addHandler(createYouTubeHandler(this.app))
    this.addHandler(createLogHandler(this.app, this.settings))
    this.addHandler(createChecklistHandler(this.app))
    this.addHandler(createAggregatorHandler(this.app))

    this.registerEditorExtension(createDirectiveExtension(this.registry))
    this.registerEditorSuggest(new DirectiveSuggest(this.app, this.registry))

    this.addCommand({
      id: 'add-to-log',
      name: 'Add to log',
      callback: async () => {
        // Scan all vault files for :::log blocks before opening the modal so
        // getItems() has the complete filtered list from the start.
        const allFiles = this.app.vault.getMarkdownFiles()
        const logFiles = (
          await Promise.all(
            allFiles.map(async f => {
              const text = await this.app.vault.cachedRead(f)
              return /^:::log/m.test(text) ? f : null
            }),
          )
        ).filter((f): f is TFile => f !== null)

        new AddToLogModal(this.app, this.settings, logFiles).open()
      },
    })
    this.registerEvent(this.app.workspace.on('file-open', () => {
      this.closeLogPopover()
      void this.syncActiveLogButton()
    }))
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      this.closeLogPopover()
      void this.syncActiveLogButton()
    }))
    this.app.workspace.onLayoutReady(() => void this.syncActiveLogButton())

    this.applyFontSettings()
    this.addSettingTab(new DirectivesSettingTab(this.app, this))
  }

  onunload(): void {
    this.closeLogPopover()
    this.fontStyleEl?.remove()
    disposeAllAudio()
    this.registry = undefined as unknown as DirectiveRegistry
  }

  applyFontSettings(): void {
    if (!this.fontStyleEl) {
      this.fontStyleEl = document.createElement('style')
      this.fontStyleEl.id = 'obsidian-directives-fonts'
      document.head.appendChild(this.fontStyleEl)
    }
    const s = this.settings
    const rule = (prop: string, val: string) =>
      val.trim() ? `  ${prop}: ${val.trim()};` : ''
    this.fontStyleEl.textContent = `:root {\n` +
      rule('--directive-font-log',     s.fontLog)     + '\n' +
      rule('--directive-font-audio',   s.fontAudio)   + '\n' +
      rule('--directive-font-chords',  s.fontChords)  + '\n' +
      rule('--directive-font-tab',     s.fontTab)     + '\n' +
      rule('--directive-font-youtube', s.fontYoutube) + '\n' +
      `}`
  }

  // ── Log view-header button ────────────────────────────────────────────────

  private async syncActiveLogButton(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view) return

    const file = view.file
    if (!file) return

    const enabled = this.settings.logViewButton
    let hasLog = false
    try {
      const content = await this.app.vault.cachedRead(file)
      hasLog = /^:::log/m.test(content)
    } catch {
      return
    }

    const show = enabled && hasLog

    if (!this.logViewButtons.has(view)) {
      if (!show) return
      const btn = view.addAction('logs', 'View log', (evt: MouseEvent) => {
        this.toggleLogPopover(evt, view)
      })
      btn.addClass('clickable-icon')
      this.logViewButtons.set(view, btn)
    } else {
      this.logViewButtons.get(view)!.style.display = show ? '' : 'none'
    }
  }

  private toggleLogPopover(evt: MouseEvent, view: MarkdownView): void {
    if (this.openLogPopover) {
      this.closeLogPopover()
      return
    }
    const file = view.file
    if (!file) return
    this.openLogPopover = new ViewLogPopover(
      this.app,
      file,
      evt.currentTarget as HTMLElement,
      () => { this.openLogPopover = null },
    )
  }

  refreshLogButton(): Promise<void> {
    return this.syncActiveLogButton()
  }

  private closeLogPopover(): void {
    this.openLogPopover?.close()
    this.openLogPopover = null
  }

  // ── Public API (ObsidianDirectivesAPI) ───────────────────────────────────

  /**
   * Register a directive handler.
   *
   * Validates the handler before registering:
   *   - `name` must match /^[a-z][a-z0-9-]*$/
   *   - `render` must be a function
   * Logs a console warning (but still registers) when:
   *   - The name matches a built-in handler
   *   - A handler for that name is already registered
   *
   * Returns an unregister function.  The handler is also auto-unregistered
   * when this plugin unloads, so calling the return value is optional.
   */
  addHandler(handler: DirectiveHandler): () => void {
    // ── Validation ──────────────────────────────────────────────────────────
    if (!handler.name || !VALID_NAME.test(handler.name)) {
      throw new Error(
        `[obsidian-directives] Invalid handler name "${handler.name}". ` +
        'Names must start with a lowercase letter and contain only ' +
        'lowercase letters, digits, and hyphens (e.g. "my-widget").',
      )
    }

    if (typeof handler.render !== 'function') {
      throw new Error(
        `[obsidian-directives] Handler "${handler.name}" is missing a render() function.`,
      )
    }

    // ── Warnings ────────────────────────────────────────────────────────────
    if (this.registry.has(handler.name)) {
      if (BUILTIN_NAMES.has(handler.name)) {
        console.warn(
          `[obsidian-directives] Handler "${handler.name}" overrides a built-in handler. ` +
          'This is allowed but may produce unexpected behaviour.',
        )
      } else {
        console.warn(
          `[obsidian-directives] A handler named "${handler.name}" is already registered ` +
          'and will be replaced.',
        )
      }
    }

    // ── Register ────────────────────────────────────────────────────────────
    this.registry.register(handler)

    const unregister = (): void => {
      this.registry.unregister(handler.name)
    }

    // Auto-cleanup when the plugin unloads (Obsidian's own mechanism).
    this.register(unregister)

    return unregister
  }

  /** Return true if a handler is registered for `name`. */
  hasHandler(name: string): boolean {
    return this.registry.has(name)
  }

  /** Return the names of all currently registered directive handlers. */
  getHandlerNames(): string[] {
    return Array.from(this.registry.registeredNames())
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    this.applyFontSettings()
  }
}
