/**
 * event-bus.ts
 *
 * A lightweight pub/sub EventBus scoped per editor view (= per open note),
 * used for decoupled cross-handler communication.
 *
 * Design decisions (from spec §3.2 and §10.2):
 *  - One EventBus per open note; directives on different notes do not share events.
 *  - Handlers never import each other — they communicate exclusively through events.
 *  - Events are namespaced: built-ins use "audio:*" / "youtube:*", third-party
 *    handlers should use their own "handlername:event" prefix.
 *
 * The EventBus is exposed as a CodeMirror StateField so any ViewPlugin or
 * handler can retrieve it with:
 *
 *   const bus = view.state.field(eventBusField)
 */

import { StateField } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import type { DirectiveEventName, DirectiveEventPayload } from '../types'

// ---------------------------------------------------------------------------
// EventBus class
// ---------------------------------------------------------------------------

type AnyCallback = (payload: unknown) => void

export class EventBus {
  private readonly listeners = new Map<string, Set<AnyCallback>>()

  /**
   * Publish `payload` to every subscriber of `event`.
   */
  publish<K extends DirectiveEventName>(
    event: K,
    payload: DirectiveEventPayload<K>,
  ): void {
    const cbs = this.listeners.get(event as string)
    if (!cbs) return
    for (const cb of cbs) {
      try {
        cb(payload)
      } catch (err) {
        console.error(`[obsidian-directives] Error in listener for "${String(event)}":`, err)
      }
    }
  }

  /**
   * Subscribe to `event`. Returns an unsubscribe function — call it in
   * your handler's `destroy()` to avoid listener leaks.
   *
   * Example:
   *   const unsub = bus.subscribe('audio:timeupdate', ({ src, time }) => { … })
   *   // later:
   *   unsub()
   */
  subscribe<K extends DirectiveEventName>(
    event: K,
    callback: (payload: DirectiveEventPayload<K>) => void,
  ): () => void {
    const key = event as string
    let cbs = this.listeners.get(key)
    if (!cbs) {
      cbs = new Set()
      this.listeners.set(key, cbs)
    }
    const cb = callback as AnyCallback
    cbs.add(cb)

    return () => {
      this.listeners.get(key)?.delete(cb)
    }
  }

  /**
   * Remove all listeners for a specific event. Useful for teardown.
   */
  clearEvent(event: DirectiveEventName): void {
    this.listeners.delete(event as string)
  }

  /**
   * Remove all listeners for all events. Called when the bus is being
   * torn down (e.g. editor view destroyed).
   */
  clearAll(): void {
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// CM6 StateField — one EventBus per editor view
// ---------------------------------------------------------------------------

/**
 * A CodeMirror StateField that holds the EventBus for a given editor view.
 * The state field itself never changes (the EventBus is mutable internally);
 * we just return the same reference on every update so CM6 doesn't invalidate
 * dependent computations unnecessarily.
 */
export const eventBusField = StateField.define<EventBus>({
  create(): EventBus {
    return new EventBus()
  },

  update(bus: EventBus, _tr: Transaction): EventBus {
    // The bus is mutable; the state field reference stays constant.
    return bus
  },
})
