/* Minimal stub — enough for pure-logic imports to resolve in Node/Vitest */

export class App {}
export class TFile { path = ''; basename = ''; parent = null }
export class TAbstractFile {}
export class Modal { app: App; contentEl = { empty() {} }; titleEl = { setText(_: string) {} }; constructor(app: App) { this.app = app } open() {} close() {} }
export class FuzzySuggestModal<T> extends Modal { constructor(app: App) { super(app) } setPlaceholder(_: string) { return this } setInstructions(_: unknown[]) { return this } getItems(): T[] { return [] } getItemText(_: T): string { return '' } onChooseItem(_: T): void {} }
export class Notice { constructor(_: string) {} }
export class Setting { setName(_: string) { return this } setDesc(_: string) { return this } setHeading() { return this } addText(_: (_: unknown) => void) { return this } addDropdown(_: (_: unknown) => void) { return this } addToggle(_: (_: unknown) => void) { return this } addButton(_: (_: unknown) => void) { return this } addSlider(_: (_: unknown) => void) { return this } get settingEl() { return { toggle(_: boolean) {} } } }
export class PluginSettingTab { containerEl = document.createElement('div'); constructor(_app: App, _plugin: unknown) {} display() {} }
export class Menu { addItem(_: (_: unknown) => void) { return this } addSeparator() { return this } showAtMouseEvent(_: MouseEvent) {} }
export class AbstractInputSuggest<T> { constructor(_app: App, _el: HTMLInputElement) {} getSuggestions(_: string): T[] { return [] } renderSuggestion(_: T, _el: HTMLElement): void {} selectSuggestion(_: T): void {} close() {} }
export function setIcon(_el: HTMLElement, _icon: string): void {}
export function prepareFuzzySearch(_query: string): (_str: string) => { score: number } | null {
  return (_str: string) => ({ score: 0 })
}
