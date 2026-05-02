import { Plugin } from 'obsidian'
import { DirectiveRegistry } from './core/registry'
import { createDirectiveExtension } from './core/decoration-engine'
import { createAudioHandler, disposeAllAudio } from './handlers/audio'
import { createChordsHandler } from './handlers/chords'
import type { DirectiveHandler } from './types'

export default class ObsidianDirectivesPlugin extends Plugin {
  registry!: DirectiveRegistry

  async onload(): Promise<void> {
    this.registry = new DirectiveRegistry()

    // Built-in handlers — registered in spec build order (§10.8):
    //   audio → chords → tab → youtube
    this.addHandler(createAudioHandler(this.app))
    this.addHandler(createChordsHandler())

    this.registerEditorExtension(createDirectiveExtension(this.registry))
  }

  onunload(): void {
    // Release all cached HTMLAudioElements so playback stops and memory is freed.
    disposeAllAudio()
    this.registry = undefined as unknown as DirectiveRegistry
  }

  /**
   * Register a handler and ensure it is automatically unregistered when the
   * plugin unloads. Prefer this over registry.register() directly.
   */
  addHandler(handler: DirectiveHandler): void {
    this.registry.register(handler)
    this.register(() => this.registry.unregister(handler.name))
  }
}
