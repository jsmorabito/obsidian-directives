import { describe, it, expect } from 'vitest'
import { parseLogBody } from '../handlers/log'
import { insertNoteIntoLog } from '../ui/add-to-log-modal'
import { DEFAULT_SETTINGS } from '../settings'
import type { DirectivesSettings } from '../settings'

function makeSettings(overrides: Partial<DirectivesSettings> = {}): DirectivesSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

// ---------------------------------------------------------------------------
// parseLogBody
// ---------------------------------------------------------------------------

describe('parseLogBody', () => {
  it('returns empty array for empty body', () => {
    expect(parseLogBody('')).toEqual([])
  })

  it('parses a single date entry with content', () => {
    const body = '- 2026-06-23\n  - Did some work\n  - More work'
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.date).toBe('2026-06-23')
    expect(entries[0]?.lines).toEqual(['- Did some work', '- More work'])
  })

  it('parses multiple date entries', () => {
    const body = '- 2026-06-23\n  - Today\n- 2026-06-22\n  - Yesterday'
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.date).toBe('2026-06-23')
    expect(entries[1]?.date).toBe('2026-06-22')
  })

  it('ignores blank lines between entries', () => {
    const body = '- 2026-06-23\n  - Entry\n\n- 2026-06-22\n  - Entry'
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(2)
  })

  it('handles heading-style date lines', () => {
    const body = '###### 2026-06-23\n- First entry'
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.date).toBe('2026-06-23')
  })

  it('handles wikilink dates', () => {
    const body = '- [[2026-06-23]]\n  - Entry'
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.date).toBe('2026-06-23')
  })

  it('handles wikilink dates with path prefix', () => {
    const body = '- [[Daily/2026-06-23]]\n  - Entry'
    const entries = parseLogBody(body)
    expect(entries[0]?.date).toBe('2026-06-23')
  })

  it('strips leading indentation from content lines', () => {
    const body = '- 2026-06-23\n    - indented entry'
    const entries = parseLogBody(body)
    expect(entries[0]?.lines[0]).toBe('- indented entry')
  })

  it('records dateOffset correctly', () => {
    const body = '- 2026-06-23\n  - Entry'
    const entries = parseLogBody(body)
    expect(entries[0]?.dateOffset).toBe(0)
  })

  it('returns no entries when body has no date lines', () => {
    const body = '## Log\nsome content without dates'
    expect(parseLogBody(body)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// insertNoteIntoLog
// ---------------------------------------------------------------------------

describe('insertNoteIntoLog', () => {
  const settings = makeSettings({ logDateHeadingLevel: 0, logDateStyle: 'plain' })

  it('returns null when no :::log block exists', () => {
    const content = '# Note\nSome content'
    expect(insertNoteIntoLog(content, '2026-06-23', 'My note', settings)).toBeNull()
  })

  it('inserts a new date entry into an empty log', () => {
    const content = ':::log\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'First entry', settings)!
    expect(result.content).toContain('- 2026-06-23')
    expect(result.content).toContain('First entry')
  })

  it('appends to an existing date entry', () => {
    const content = ':::log\n- 2026-06-23\n    - First\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'Second', settings)!
    expect(result.content).toContain('First')
    expect(result.content).toContain('Second')
    // Second should appear after First
    expect(result.content.indexOf('Second')).toBeGreaterThan(result.content.indexOf('First'))
  })

  it('inserts newer date before existing older date', () => {
    const content = ':::log\n- 2026-06-22\n    - Old entry\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'New entry', settings)!
    expect(result.content.indexOf('2026-06-23')).toBeLessThan(result.content.indexOf('2026-06-22'))
  })

  it('inserts older date after existing newer date', () => {
    const content = ':::log\n- 2026-06-23\n    - New entry\n:::'
    const result = insertNoteIntoLog(content, '2026-06-21', 'Old entry', settings)!
    expect(result.content.indexOf('2026-06-23')).toBeLessThan(result.content.indexOf('2026-06-21'))
  })

  it('skips a title heading at the top of the body', () => {
    const content = ':::log\n## Log\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'Entry', settings)!
    expect(result.content).toContain('## Log')
    expect(result.content).toContain('2026-06-23')
    // Title heading must come before the date line
    expect(result.content.indexOf('## Log')).toBeLessThan(result.content.indexOf('2026-06-23'))
  })

  it('uses heading prefix when logDateHeadingLevel > 0', () => {
    const s = makeSettings({ logDateHeadingLevel: 6, logDateStyle: 'plain' })
    const content = ':::log\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'Entry', s)!
    expect(result.content).toContain('###### 2026-06-23')
  })

  it('uses wikilink format when logDateStyle=wikilink', () => {
    const s = makeSettings({ logDateStyle: 'wikilink', logDateFormat: 'Daily/{{date}}', logDateHeadingLevel: 0 })
    const content = ':::log\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'Entry', s)!
    expect(result.content).toContain('[[Daily/2026-06-23]]')
  })

  it('handles multiple existing entries and inserts in correct order', () => {
    const content = ':::log\n- 2026-06-23\n    - A\n- 2026-06-20\n    - B\n:::'
    const result = insertNoteIntoLog(content, '2026-06-21', 'Middle', settings)!
    const pos23 = result.content.indexOf('2026-06-23')
    const pos21 = result.content.indexOf('2026-06-21')
    const pos20 = result.content.indexOf('2026-06-20')
    expect(pos23).toBeLessThan(pos21)
    expect(pos21).toBeLessThan(pos20)
  })

  it('reports the entry offset at the inserted note line', () => {
    const content = ':::log\n:::'
    const result = insertNoteIntoLog(content, '2026-06-23', 'First entry', settings)!
    expect(result.content.slice(result.entryOffset, result.entryOffset + 'First entry'.length)).toBe('First entry')
  })
})
