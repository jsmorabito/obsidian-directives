/**
 * ui/settings-tab.ts
 *
 * Settings panel shown under Obsidian Settings → Community plugins →
 * Obsidian Directives.
 *
 * Uses Obsidian's native Setting API so the UI automatically inherits
 * the active theme.
 */

import { App, PluginSettingTab, Setting } from 'obsidian'
import type ObsidianDirectivesPlugin from '../main'

export class DirectivesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianDirectivesPlugin) {
    super(app, plugin)
  }

  private addFontSetting(
    containerEl: HTMLElement,
    label: string,
    desc: string,
    get: () => string,
    set: (v: string) => Promise<void>,
  ): void {
    let currentText = ''
    new Setting(containerEl)
      .setName(label)
      .setDesc(desc)
      .addText(text => {
        // eslint-disable-next-line obsidianmd/ui/sentence-case -- font name is a proper noun, not prose
        text.setPlaceholder('e.g. New York').setValue(get())
        currentText = get()
        text.inputEl.addEventListener('input', () => { currentText = text.inputEl.value })
        text.inputEl.addEventListener('blur', () => { void set(currentText) })
        text.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') void set(currentText)
        })
      })
      .addButton(btn =>
        btn.setButtonText('Apply').setCta().onClick(async () => {
          await set(currentText)
        }),
      )
      .addButton(btn =>
        btn.setButtonText('Reset').onClick(async () => {
          await set('')
          this.display()
        }),
      )
  }

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // ── Log directive ──────────────────────────────────────────────────────

    new Setting(containerEl).setName("Log directive").setHeading()

    new Setting(containerEl)
      .setName('Date heading level')
      .setDesc(
        'Render each date entry as a Markdown heading so it appears in ' +
        "Obsidian's Outline panel. Choose \"List item\" to keep the original " +
        'bullet-point style (no outline entry).',
      )
      .addDropdown(drop =>
        drop
          .addOption('0', 'List item  (- date)')
          .addOption('1', 'H1  (#)')
          .addOption('2', 'H2  (##)')
          .addOption('3', 'H3  (###)')
          .addOption('4', 'H4  (####)')
          .addOption('5', 'H5  (#####)')
          .addOption('6', 'H6  (######)')
          .setValue(String(this.plugin.settings.logDateHeadingLevel))
          .onChange(async value => {
            this.plugin.settings.logDateHeadingLevel =
              Number(value) as typeof this.plugin.settings.logDateHeadingLevel
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Title heading level')
      .setDesc(
        'Insert a Markdown heading for "Log" at the top of the directive body ' +
        "so it appears in Obsidian's Outline panel. " +
        'Only applied when a new :::log block is created via autocomplete. ' +
        'Choose "None" to skip the heading.',
      )
      .addDropdown(drop =>
        drop
          .addOption('0', 'None')
          .addOption('1', 'H1  (#)')
          .addOption('2', 'H2  (##)')
          .addOption('3', 'H3  (###)')
          .addOption('4', 'H4  (####)')
          .addOption('5', 'H5  (#####)')
          .addOption('6', 'H6  (######)')
          .setValue(String(this.plugin.settings.logTitleHeadingLevel))
          .onChange(async value => {
            this.plugin.settings.logTitleHeadingLevel =
              Number(value) as typeof this.plugin.settings.logTitleHeadingLevel
            await this.plugin.saveSettings()
          }),
      )

    let formatSetting: Setting

    new Setting(containerEl)
      .setName('Date style')
      .setDesc('How dates are displayed in :::log widgets.')
      .addDropdown(drop =>
        drop
          .addOption('plain',    'Plain text — 2026-06-17')
          .addOption('wikilink', 'Wikilink — [[2026-06-17]]')
          .setValue(this.plugin.settings.logDateStyle)
          .onChange(async value => {
            this.plugin.settings.logDateStyle =
              value as typeof this.plugin.settings.logDateStyle
            await this.plugin.saveSettings()
            // Show/hide the format row depending on the chosen style.
            formatSetting.settingEl.toggle(value === 'wikilink')
          }),
      )

    formatSetting = new Setting(containerEl)
      .setName('Wikilink format')
      .setDesc(
        'Path template for the wikilink target. ' +
        '{{date}} is replaced with the entry date (YYYY-MM-DD). ' +
        'Example: "Daily/{{date}}" produces [[Daily/2026-06-17]].',
      )
      .addText(text =>
        text
          .setPlaceholder('{{date}}')
          .setValue(this.plugin.settings.logDateFormat)
          .onChange(async value => {
            this.plugin.settings.logDateFormat = value || '{{date}}'
            await this.plugin.saveSettings()
          }),
      )

    // Show the format row only when wikilink style is active.
    formatSetting.settingEl.toggle(
      this.plugin.settings.logDateStyle === 'wikilink',
    )

    new Setting(containerEl)
      .setName('Show log preview button')
      .setDesc(
        'Add a button to the editor header bar that opens a quick-look popover ' +
        'of your log entries. Click an entry date to jump to it in the editor.',
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.logViewButton)
          .onChange(async value => {
            this.plugin.settings.logViewButton = value
            await this.plugin.saveSettings()
            void this.plugin.refreshLogButton()
          }),
      )

    this.addFontSetting(
      containerEl,
      'Font',
      'Font for log body lines. Leave empty to use your default text font.',
      () => this.plugin.settings.fontLog,
      async v => { this.plugin.settings.fontLog = v; await this.plugin.saveSettings() },
    )

    // ── Tab directive ──────────────────────────────────────────────────────

    new Setting(containerEl).setName("Tab directive").setHeading()

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName('Default BPM')
      .setDesc(
        'Beats per minute used when a :::tab block does not include a bpm= attribute. ' +
        'Range: 20 – 300.',
      )
      .addSlider(slider =>
        slider
          .setLimits(20, 300, 1)
          .setValue(this.plugin.settings.defaultBpm)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.defaultBpm = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Default chars per beat')
      .setDesc(
        'How many monospace characters equal one beat in your tab notation. ' +
        '2 = eighth-note dashes (most common), 4 = sixteenth-note dashes. ' +
        'Range: 1 – 16.',
      )
      .addSlider(slider =>
        slider
          .setLimits(1, 16, 1)
          .setValue(this.plugin.settings.defaultCpb)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.defaultCpb = value
            await this.plugin.saveSettings()
          }),
      )

    this.addFontSetting(
      containerEl,
      'Font',
      'Font for :::tab widgets. Leave empty to use the default.',
      () => this.plugin.settings.fontTab,
      async v => { this.plugin.settings.fontTab = v; await this.plugin.saveSettings() },
    )

    // ── Chords directive ───────────────────────────────────────────────────

    new Setting(containerEl).setName("Chords directive").setHeading()

    new Setting(containerEl)
      .setName('Default layout')
      .setDesc(
        'How chord diagrams are arranged when a :::chords block does not include ' +
        'a layout= attribute.',
      )
      .addDropdown(drop =>
        drop
          .addOption('grid',       'Grid — wrapping flex layout (default)')
          .addOption('horizontal', 'Horizontal — single scrollable row')
          .addOption('vertical',   'Vertical — one chord per row')
          .addOption('text',       'Text — names only, no diagrams')
          .setValue(this.plugin.settings.defaultChordLayout)
          .onChange(async value => {
            this.plugin.settings.defaultChordLayout =
              value as typeof this.plugin.settings.defaultChordLayout
            await this.plugin.saveSettings()
          }),
      )
    this.addFontSetting(
      containerEl,
      'Font',
      'Font for :::chords widgets. Leave empty to use the default.',
      () => this.plugin.settings.fontChords,
      async v => { this.plugin.settings.fontChords = v; await this.plugin.saveSettings() },
    )

    // ── Audio directive ────────────────────────────────────────────────────

    new Setting(containerEl).setName('Audio directive').setHeading()

    this.addFontSetting(
      containerEl,
      'Font',
      'Font for :::audio widgets. Leave empty to use the default.',
      () => this.plugin.settings.fontAudio,
      async v => { this.plugin.settings.fontAudio = v; await this.plugin.saveSettings() },
    )

    // ── YouTube directive ──────────────────────────────────────────────────

    new Setting(containerEl).setName('YouTube directive').setHeading()

    this.addFontSetting(
      containerEl,
      'Font',
      'Font for :::youtube widgets. Leave empty to use the default.',
      () => this.plugin.settings.fontYoutube,
      async v => { this.plugin.settings.fontYoutube = v; await this.plugin.saveSettings() },
    )
  }
}
