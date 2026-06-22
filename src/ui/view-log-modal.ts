/**
 * ui/view-log-modal.ts
 *
 * "View log" popover — anchored to the view-header action button, styled with
 * Obsidian's native .popover.hover-popover classes (same approach as the
 * check-mate checklist plugin).
 */

import { App, Notice, TFile } from 'obsidian'
import type { DirectivesSettings } from '../settings'
import { insertNoteIntoLog } from './add-to-log-modal'
import { parseLogBody } from '../handlers/log'

// ---------------------------------------------------------------------------
// Log block parser
// ---------------------------------------------------------------------------

const LOG_OPEN_RE = /^:::log(?:\[([^\]]*)\])?[^\n]*\n/m

interface LogBlock {
  label: string | null
  body: string
}

function extractLogBlock(content: string): LogBlock | null {
  const openMatch = LOG_OPEN_RE.exec(content)
  if (!openMatch) return null

  const afterOpen = openMatch.index + openMatch[0].length
  const closeMatch = /^:::\s*$/m.exec(content.slice(afterOpen))
  if (!closeMatch) return null

  return {
    label: openMatch[1] ?? null,
    body: content.slice(afterOpen, afterOpen + closeMatch.index),
  }
}

function todayISO(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export class ViewLogPopover {
  private el: HTMLElement
  private entriesEl!: HTMLElement
  private outsideClickHandler: (e: MouseEvent) => void

  constructor(
    private readonly app: App,
    private readonly file: TFile,
    private readonly settings: DirectivesSettings,
    anchorEl: HTMLElement,
    private readonly onClose?: () => void,
  ) {
    const rect = anchorEl.getBoundingClientRect()

    this.el = document.body.createDiv({ cls: 'view-log-popover' })
    this.el.style.top = `${rect.bottom + 4}px`
    this.el.style.right = `${window.innerWidth - rect.right}px`
    this.el.style.width = '360px'

    this.build(this.el)

    this.outsideClickHandler = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node) && e.target !== anchorEl) {
        this.close()
      }
    }
    // Defer so the button's own click doesn't immediately close it
    setTimeout(() => document.addEventListener('mousedown', this.outsideClickHandler), 0)
  }

  private async build(container: HTMLElement): Promise<void> {
    const content = await this.app.vault.read(this.file)
    const block = extractLogBlock(content)

    // Header
    const header = container.createDiv({ cls: 'view-log-popover-header' })
    header.createSpan({ cls: 'view-log-popover-title', text: block?.label ?? 'Log' })

    this.buildAddForm(container)

    this.entriesEl = container.createDiv({ cls: 'view-log-entries' })

    if (!block) {
      this.entriesEl.createDiv({ cls: 'pane-empty', text: 'No :::log block found.' })
      return
    }

    this.renderEntries(block.body)
  }

  private buildAddForm(container: HTMLElement): void {
    const form = container.createDiv({ cls: 'view-log-add-form' })

    const dateInput = form.createEl('input', { cls: 'view-log-date-input' })
    dateInput.type = 'date'
    dateInput.value = todayISO()

    const noteInput = form.createEl('input', { cls: 'view-log-note-input' })
    noteInput.type = 'text'
    noteInput.placeholder = 'Add a note…'

    const addBtn = form.createEl('button', { text: 'Add', cls: 'mod-cta view-log-add-btn' })

    const doAdd = async () => {
      const date = dateInput.value
      const note = noteInput.value.trim()
      if (!date || !note) {
        if (!note) noteInput.focus()
        return
      }

      const latest = await this.app.vault.read(this.file)
      const updated = insertNoteIntoLog(latest, date, note, this.settings)

      if (updated === null) {
        new Notice(`No :::log block found in "${this.file.basename}"`)
        return
      }

      await this.app.vault.modify(this.file, updated)
      noteInput.value = ''

      const refreshed = await this.app.vault.read(this.file)
      const block = extractLogBlock(refreshed)
      if (block) {
        this.entriesEl.empty()
        this.renderEntries(block.body)
      }
    }

    addBtn.addEventListener('click', doAdd)
    noteInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') doAdd()
      if (e.key === 'Escape') this.close()
    })

    setTimeout(() => noteInput.focus(), 50)
  }

  private renderEntries(body: string): void {
    const entries = parseLogBody(body)

    if (entries.length === 0) {
      this.entriesEl.createDiv({ cls: 'pane-empty', text: 'No entries yet.' })
      return
    }

    for (const entry of entries) {
      const section = this.entriesEl.createDiv({ cls: 'view-log-entry' })
      section.createDiv({ cls: 'view-log-entry-date', text: entry.date })

      if (entry.lines.length > 0) {
        const ul = section.createEl('ul', { cls: 'view-log-entry-items' })
        for (const line of entry.lines) {
          const text = line.replace(/^\s*-\s*/, '').trim()
          if (text) ul.createEl('li', { text })
        }
      }
    }
  }

  close(): void {
    document.removeEventListener('mousedown', this.outsideClickHandler)
    this.el.remove()
    this.onClose?.()
  }
}
