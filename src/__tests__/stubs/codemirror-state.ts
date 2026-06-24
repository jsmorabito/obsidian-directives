/* Minimal CM6 state stub */
export class StateField<T> {
  static define<T>(_config: { create(_: unknown): T; update(_: T, _tr: unknown): T }): StateField<T> {
    return new StateField<T>()
  }
}
export class EditorState {}
export class Transaction {}
export class Facet<I, O = I> {
  static define<I, O = I>(): Facet<I, O> { return new Facet() }
  of(_: I): unknown { return null }
}
export class RangeSet<T> {
  iter(): { value: T | null; from: number; next(): void } {
    return { value: null, from: 0, next() {} }
  }
  static empty = new RangeSet()
}
export class RangeSetBuilder<T> {
  add(_from: number, _to: number, _value: T): this { return this }
  finish(): RangeSet<T> { return new RangeSet() }
}
