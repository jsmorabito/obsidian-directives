/* Minimal CM6 view stub */
export class EditorView {}
export class WidgetType {
  eq(_other: WidgetType): boolean { return false }
  destroy(_dom: HTMLElement): void {}
  ignoreEvent(): boolean { return true }
}
export class ViewPlugin<V> {
  static define<V>(_create: (_view: EditorView) => V, _spec?: unknown): ViewPlugin<V> {
    return new ViewPlugin<V>()
  }
  static fromClass<V>(_cls: new (_view: EditorView) => V, _spec?: unknown): ViewPlugin<V> {
    return new ViewPlugin<V>()
  }
}
export class Decoration {
  static replace(_spec: unknown): unknown { return null }
  static line(_spec: unknown): unknown { return null }
  static widget(_spec: unknown): unknown { return null }
  static mark(_spec: unknown): unknown { return null }
  static set(_items: unknown[]): unknown { return null }
}
