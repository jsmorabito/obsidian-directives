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
import { DATE_RE, extractDate, todayISO, buildDateLine } from '../core/utils'

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
 * Returns the modified content string, or null if no :::log block is found.
 */
export function insertNoteIntoLog(
  content: string,
  dateISO: string,
  noteText: string,
  settings: DirectivesSettings,
): string | null {
  const openMatch = LOG_OPEN_RE.exec(content)
  if (!openMatch) return null

  const afterOpen = openMatch.index + openMatch[0].length + 1  // first char of body

  const closeMatch = /^:::\s*$/m.exec(content.slice(afterOpen))
  if (!closeMatch) return null

  const body = content.slice(afterOpen, afterOpen + closeMatch.index)
  const bodyLines = body.split('\n')

  // Skip title heading (e.g. "## Log").
  const firstBodyLine = bodyLines[0]?.trimEnd() ?? ''
  const firstIsTitle = firstBodyLine.startsWith('#') && !DATE_RE.exec(firstBodyLine)
  const titleOffset = firstIsTitle ? firstBodyLine.length + 1 : 0
  const scanFrom = firstIsTitle ? 1 : 0

  const subPrefix = settings.logDateHeadingLevel > 0 ? '- ' : '    - '

  // Walk lines to find the target date or the right insertion point.
  let charCount = titleOffset

  for (let i = scanFrom; i < bodyLines.length; i++) {
    const line = bodyLines[i] ?? ''
    const match = DATE_RE.exec(line.trimEnd())

    if (match) {
      const existing = extractDate(match)

      if (existing === dateISO) {
        // Found the target date — scan forward to the end of its content lines,
        // then append the note just before the next date entry (or end of body).
        let appendOffset = charCount + line.length + 1  // start of next line after date heading

        for (let j = i + 1; j < bodyLines.length; j++) {
          const nextLine = bodyLines[j] ?? ''
          if (DATE_RE.exec(nextLine.trimEnd())) break  // hit next date — stop
          if (nextLine.trim()) {
            appendOffset = charCount + line.length + 1
            // Advance appendOffset past all content lines up to j.
            let c = charCount + line.length + 1
            for (let k = i + 1; k <= j; k++) {
              c += (bodyLines[k]?.length ?? 0) + 1
            }
            appendOffset = c
          }
        }

        const absAppend = afterOpen + appendOffset
        const toInsert = `${subPrefix}${noteText}\n`
        return content.slice(0, absAppend) + toInsert + content.slice(absAppend)
      }

      if (dateISO > existing) {
        // New date is newer — insert a full new entry before this one.
        const absInsert = afterOpen + charCount
        const toInsert = `${buildDateLine(dateISO, settings)}\n${subPrefix}${noteText}\n`
        return content.slice(0, absInsert) + toInsert + content.slice(absInsert)
      }
    }

    charCount += line.length + 1
  }

  // Date is older than all existing entries — append at end of entries.
  const absInsert = afterOpen + charCount
  const toInsert = `${buildDateLine(dateISO, settings)}\n${subPrefix}${noteText}\n`
  return content.slice(0, absInsert) + toInsert + content.slice(absInsert)
}

// ---------------------------------------------------------------------------
// Step 2 — Combined date + note modal
// ---------------------------------------------------------------------------

class LogEntryModal extends Modal {
  private dateInput!: HTMLInputElement
  private noteInput!: HTMLInputElement

  constructor(
    app: App,
    private readonly file: TFile,
    private readonly settings: DirectivesSettings,
    private readonly onConfirm: (dateISO: string, note: string) => void,
  ) {
    super(app)
  }

  onOpen(): void {
    this.titleEl.setText('Add to log')
    const { contentEl } = this

    contentEl.createDiv({ cls: 'add-to-log-desc', text: this.file.basename })

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

    requestAnimationFrame(() => this.noteInput.focus())
  }

  private confirm(): void {
    const date = this.dateInput.value
    const note = this.noteInput.value.trim()
    if (!date || !note) {
      if (!note) this.noteInput.focus()
      return
    }
    this.close()
    this.onConfirm(date, note)
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
    }).open()
  }

  private async addNote(file: TFile, dateISO: string, note: string): Promise<void> {
    const content = await this.app.vault.read(file)
    const updated = insertNoteIntoLog(content, dateISO, note, this.settings)

    if (updated === null) {
      new Notice(`No :::log block found in "${file.basename}"`)
      return
    }

    await this.app.vault.modify(file, updated)
    new Notice(`Added to ${file.basename} · ${dateISO}`)
  }
}
