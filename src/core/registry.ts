/**
 * registry.ts
 *
 * The DirectiveRegistry maps directive names to their handlers.
 * One registry instance is created by the plugin and shared across all
 * editor extensions via a closure.
 */

import type { DirectiveHandler } from '../types'

export class DirectiveRegistry {
  private readonly handlers = new Map<string, DirectiveHandler>()

  /**
   * Register a handler for a directive name.
   * Warns in the console if a handler for that name is already registered,
   * and replaces the previous registration.
   */
  register(handler: DirectiveHandler): void {
    if (this.handlers.has(handler.name)) {
      console.warn(
        `[obsidian-directives] A handler for "${handler.name}" is already ` +
          'registered. The previous registration will be replaced.',
      )
    }
    this.handlers.set(handler.name, handler)
  }

  /**
   * Remove the handler registered for `name`.
   * No-op if no handler is registered under that name.
   */
  unregister(name: string): void {
    this.handlers.delete(name)
  }

  /**
   * Return the handler registered for `name`, or undefined if none.
   */
  get(name: string): DirectiveHandler | undefined {
    return this.handlers.get(name)
  }

  /**
   * Return all registered handlers as an array.
   */
  getAll(): DirectiveHandler[] {
    return Array.from(this.handlers.values())
  }

  /**
   * Return true if a handler is registered for `name`.
   */
  has(name: string): boolean {
    return this.handlers.has(name)
  }

  /**
   * Return the set of all registered directive names.
   */
  registeredNames(): Set<string> {
    return new Set(this.handlers.keys())
  }
}
