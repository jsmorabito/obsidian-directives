/* Minimal CM6 language stub */
export const foldService = { of(_fn: unknown): unknown { return null } }
export function foldEffect(_range: { from: number; to: number }): unknown { return null }
export function unfoldEffect(_range: { from: number; to: number }): unknown { return null }
export function foldedRanges(_state: unknown): { iter(): { value: unknown; from: number; next(): void } } {
  return { iter: () => ({ value: null, from: 0, next() {} }) }
}

// Make foldEffect and unfoldEffect work as both functions and objects with .of()
Object.assign(foldEffect, { of: foldEffect })
Object.assign(unfoldEffect, { of: unfoldEffect })
