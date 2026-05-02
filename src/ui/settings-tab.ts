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

  display(): void {
    const { containerEl } = this
    containerEl.empty()

    // ── Tab directive ──────────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Tab directive' })

    new Setting(containerEl)
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

    // ── Chords directive ───────────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Chords directive' })

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
  }
}
