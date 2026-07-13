/**
 * ui/add-to-log-modal.ts
 *
 * Two-step command flow for "Add to log":
 *   1. AddToLogModal (FuzzySuggestModal) — pick a file containing :::log
 *   2. LogEntryModal (Modal)             — choose date + type note content
 *
 * The note is appended to that day's existing entries, or a new date entry
 * is created if none exists for that date.
 */

import {
  App,
  FuzzySuggestModal,
  Modal,
  Notice,
  TFile,
  setIcon,
} from 'obsidian'
import type { DirectivesSettings } from '../settings'
import {
  todayISO, buildDateLine, buildMonthLine, monthOf, locateLogInsertion, resolveMonthHeadingLevel,
} from '../core/utils'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LOG_OPEN_RE = /^:::log[^\n]*$/m

// ---------------------------------------------------------------------------
// Core insertion logic
// ---------------------------------------------------------------------------

/**
 * Insert `noteText` into the first :::log block in `content`.
 *
 * - If an entry for `dateISO` already exists, the note is appended after the
 *   last content line of that entry.
 * - If no entry exists for `dateISO`, a new dated entry is created in
 *   chronological (newest-first) order.
 *
 * Returns the modified content and the character offset of the inserted note
 * line, or null if no :::log block is found.
 */
export function insertNoteIntoLog(
  content: string,
  dateISO: string,
  noteText: string,
  settings: DirectivesSettings,
): { content: string; entryOffset: number } | null {
  const openMatch = LOG_OPEN_RE.exec(content)
  if (!openMatch) return null

  const afterOpen = openMatch.index + openMatch[0].length + 1  // first char of body

  const closeMatch = /^:::\s*$/m.exec(content.slice(afterOpen))
  if (!closeMatch) return null

  const body = content.slice(afterOpen, afterOpen + closeMatch.index)
  const point = locateLogInsertion(body, dateISO, settings)

  if (point.found) {
    // Append the note just before the next date entry (or end of body).
    const absAppend = afterOpen + point.entryEnd
    const toInsert = `${point.contentPrefix}${noteText}\n`
    return {
      content: content.slice(0, absAppend) + toInsert + content.slice(absAppend),
      entryOffset: absAppend + point.contentPrefix.length,
    }
  }

  if (point.needsMonthLine && resolveMonthHeadingLevel(settings) === null) return null

  const dateLineText = point.dateIndent + buildDateLine(dateISO, settings)
  const prefix = point.needsMonthLine
    ? `${buildMonthLine(point.monthStr ?? monthOf(dateISO), settings)}\n${dateLineText}\n`
    : `${dateLineText}\n`
  const absInsert = afterOpen + point.insertAt
  const toInsert = `${prefix}${point.contentPrefix}${noteText}\n`
  return {
    content: content.slice(0, absInsert) + toInsert + content.slice(absInsert),
    entryOffset: absInsert + prefix.length + point.contentPrefix.length,
  }
}

// ---------------------------------------------------------------------------
// Step 2 — Combined date + note modal
// ---------------------------------------------------------------------------

class LogEntryModal extends Modal {
  private dateInput!: HTMLInputElement
  private noteInput!: HTMLInputElement
  private isActivity: boolean

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly settings: DirectivesSettings,
    private readonly onConfirm: (dateISO: string, note: string) => void | Promise<void>,
    initialMode: 'note' | 'activity' = 'note',
  ) {
    super(app)
    this.isActivity = initialMode === 'activity'
  }

  onOpen(): void {
    this.titleEl.setText('Add to log')
    const { contentEl } = this

    contentEl.createDiv({ cls: 'add-to-log-desc', text: this.file.basename })

    // Segmented control — Note / Activity
    const segWrap = contentEl.createDiv({ cls: 'add-to-log-segment' })
    const noteBtn = segWrap.createEl('button', { text: 'Note', cls: 'add-to-log-segment-btn' })
    const activityBtn = segWrap.createEl('button', { text: 'Activity', cls: 'add-to-log-segment-btn' })

    const setMode = (activity: boolean) => {
      this.isActivity = activity
      noteBtn.toggleClass('is-active', !activity)
      activityBtn.toggleClass('is-active', activity)
    }

    setMode(this.isActivity)
    noteBtn.addEventListener('click', () => setMode(false))
    activityBtn.addEventListener('click', () => setMode(true))

    // Date row
    const dateRow = contentEl.createDiv({ cls: 'add-to-log-field-row' })
    dateRow.createEl('label', { text: 'Date', cls: 'add-to-log-label' })
    this.dateInput = dateRow.createEl('input')
    this.dateInput.type = 'date'
    this.dateInput.value = todayISO()
    this.dateInput.className = 'add-to-log-date-native'

    // Note row
    const noteRow = contentEl.createDiv({ cls: 'add-to-log-field-row' })
    noteRow.createEl('label', { text: 'Note', cls: 'add-to-log-label' })
    this.noteInput = noteRow.createEl('input')
    this.noteInput.type = 'text'
    this.noteInput.placeholder = 'What did you do?'
    this.noteInput.className = 'add-to-log-note-input'

    // Button row
    const btnRow = contentEl.createDiv({ cls: 'add-to-log-btn-row' })
    const confirmBtn = btnRow.createEl('button', { text: 'Add entry' })
    confirmBtn.className = 'mod-cta'
    confirmBtn.addEventListener('click', () => this.confirm())

    this.noteInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.confirm()
      if (e.key === 'Escape') this.close()
    })

    window.requestAnimationFrame(() => this.noteInput.focus())
  }

  private confirm(): void {
    const date = this.dateInput.value
    const note = this.noteInput.value.trim()
    if (!date || !note) {
      if (!note) this.noteInput.focus()
      return
    }
    const finalNote = this.isActivity
      ? `[activity] ${new Date().toTimeString().slice(0, 5)} ${note}`
      : note
    this.close()
    void this.onConfirm(date, finalNote)
  }

  onClose(): void {
    this.contentEl.empty()
  }
}

// ---------------------------------------------------------------------------
// Step 1 — File suggest modal
// ---------------------------------------------------------------------------

export class AddToLogModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly settings: DirectivesSettings,
    private readonly logFiles: TFile[],
    private readonly initialMode: 'note' | 'activity' = 'note',
  ) {
    super(app)
    this.setPlaceholder('Search for a note with a log...')
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'select' },
      { command: 'esc', purpose: 'cancel' },
    ])
  }

  getItems(): TFile[] {
    return this.logFiles
  }

  getItemText(file: TFile): string {
    return file.path.replace(/\.md$/, '')
  }

  renderSuggestion(item: { item: TFile }, el: HTMLElement): void {
    const row = el.createDiv({ cls: 'add-to-log-suggestion' })
    const icon = row.createSpan({ cls: 'add-to-log-suggestion-icon' })
    setIcon(icon, 'logs')
    row.createSpan({ text: item.item.path.replace(/\.md$/, '') })
  }

  onChooseItem(file: TFile): void {
    new LogEntryModal(this.app, file, this.settings, async (dateISO, note) => {
      await this.addNote(file, dateISO, note)
    }, this.initialMode).open()
  }

  private async addNote(file: TFile, dateISO: string, note: string): Promise<void> {
    const content = await this.app.vault.read(file)
    const result = insertNoteIntoLog(content, dateISO, note, this.settings)

    if (result === null) {
      new Notice(`No :::log block found in "${file.basename}"`)
      return
    }

    await this.app.vault.modify(file, result.content)
    const line = result.content.slice(0, result.entryOffset).split('\n').length - 1

    const fragment = createFragment((el) => {
      el.appendText('Added to ')
      const link = el.createEl('a', { text: file.basename, cls: 'add-to-log-notice-link' })
      link.addEventListener('click', (e) => {
        e.preventDefault()
        void this.app.workspace.getLeaf(false).openFile(file, { eState: { line } })
      })
      el.appendText(` · ${dateISO}`)
    })
    new Notice(fragment)
  }
}
