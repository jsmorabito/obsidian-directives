import { App, Component, MarkdownRenderer, MarkdownView, TFile } from 'obsidian'
import { parseLogBody } from '../handlers/log'

// ---------------------------------------------------------------------------
// Log block extractor
// ---------------------------------------------------------------------------

const LOG_OPEN_RE = /^:::log(?:\[([^\]]*)\])?[^\n]*\n/m

interface LogBlock {
  label: string | null
  bodyStart: number
  body: string
}

function extractLogBlock(content: string): LogBlock | null {
  const openMatch = LOG_OPEN_RE.exec(content)
  if (!openMatch) return null

  const bodyStart = openMatch.index + openMatch[0].length
  const closeMatch = /^:::\s*$/m.exec(content.slice(bodyStart))
  if (!closeMatch) return null

  return {
    label: openMatch[1] ?? null,
    bodyStart,
    body: content.slice(bodyStart, bodyStart + closeMatch.index),
  }
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export class ViewLogPopover {
  private el: HTMLElement
  private component: Component
  private outsideClickHandler: (e: MouseEvent) => void

  constructor(
    private readonly app: App,
    private readonly file: TFile,
    anchorEl: HTMLElement,
    private readonly onClose?: () => void,
  ) {
    const rect = anchorEl.getBoundingClientRect()

    this.component = new Component()
    this.component.load()

    this.el = activeDocument.body.createDiv({ cls: 'view-log-popover' })
    this.el.style.top = `${rect.bottom + 4}px`
    this.el.style.right = `${window.innerWidth - rect.right}px`

    void this.build(this.el)

    this.outsideClickHandler = (e: MouseEvent) => {
      if (!this.el.contains(e.target as Node) && e.target !== anchorEl) {
        this.close()
      }
    }
    window.setTimeout(() => activeDocument.addEventListener('mousedown', this.outsideClickHandler), 0)
  }

  private async build(container: HTMLElement): Promise<void> {
    const content = await this.app.vault.read(this.file)
    const block = extractLogBlock(content)

    const header = container.createDiv({ cls: 'view-log-popover-header' })
    header.createSpan({ cls: 'view-log-popover-title', text: block?.label ?? 'Log' })

    const entriesEl = container.createDiv({ cls: 'view-log-entries' })

    if (!block) {
      entriesEl.createDiv({ cls: 'view-log-empty', text: 'No :::log block found.' })
      return
    }

    const entries = parseLogBody(block.body)

    if (entries.length === 0) {
      entriesEl.createDiv({ cls: 'view-log-empty', text: 'No entries yet.' })
      return
    }

    for (const entry of entries) {
      const sectionEl = entriesEl.createDiv({ cls: 'view-log-entry' })

      const dateEl = sectionEl.createDiv({ cls: 'view-log-entry-date' })
      dateEl.textContent = entry.date
      dateEl.setAttribute('role', 'button')
      dateEl.setAttribute('tabindex', '0')
      const absOffset = block.bodyStart + entry.dateOffset
      dateEl.addEventListener('click', () => this.navigateTo(absOffset))
      dateEl.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') this.navigateTo(absOffset)
      })

      const contentEl = sectionEl.createDiv({ cls: 'view-log-entry-content' })
      await MarkdownRenderer.render(
        this.app, entry.lines.join('\n'), contentEl, this.file.path, this.component,
      )
    }
  }

  private navigateTo(charOffset: number): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView)
    if (!view || view.file?.path !== this.file.path) return
    const pos = view.editor.offsetToPos(charOffset)
    view.editor.setCursor(pos)
    view.editor.scrollIntoView({ from: pos, to: pos }, true)
    this.close()
  }

  close(): void {
    activeDocument.removeEventListener('mousedown', this.outsideClickHandler)
    this.component.unload()
    this.el.remove()
    this.onClose?.()
  }
}
