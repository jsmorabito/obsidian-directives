/**
 * settings.ts
 *
 * Plugin settings for Obsidian Directives.
 * No configurable settings in v1 — this file is a placeholder for future
 * settings (e.g. theme overrides, chord library options, BPM defaults).
 */

export interface DirectivesSettings {
  // Reserved for future settings.
  _version: number
}

export const DEFAULT_SETTINGS: DirectivesSettings = {
  _version: 1,
}
