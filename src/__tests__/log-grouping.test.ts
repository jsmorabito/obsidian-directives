import { describe, it, expect } from 'vitest'
import { parseLogBody, groupLogByMonth } from '../handlers/log'
import { insertNoteIntoLog } from '../ui/add-to-log-modal'
import { DEFAULT_SETTINGS } from '../settings'
import type { DirectivesSettings } from '../settings'

function makeSettings(overrides: Partial<DirectivesSettings> = {}): DirectivesSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

const listSettings = makeSettings({ logDateHeadingLevel: 0, logDateStyle: 'plain' })
const headingSettings = makeSettings({ logDateHeadingLevel: 6, logDateStyle: 'plain' })

// ---------------------------------------------------------------------------
// parseLogBody — nested (already-grouped) bodies
// ---------------------------------------------------------------------------

describe('parseLogBody with month groups', () => {
  it('parses nested list-mode entries and skips the month line', () => {
    const body = [
      '- 2026-07',
      '    - 2026-07-13',
      '        - Work A',
      '    - 2026-07-09',
      '        - Work B',
    ].join('\n')
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.date).toBe('2026-07-13')
    expect(entries[0]?.lines).toEqual(['- Work A'])
    expect(entries[1]?.date).toBe('2026-07-09')
    expect(entries[1]?.lines).toEqual(['- Work B'])
  })

  it('parses nested heading-mode entries and skips the month heading', () => {
    const body = [
      '##### 2026-07',
      '###### 2026-07-13',
      '- Work A',
      '###### 2026-07-09',
      '- Work B',
    ].join('\n')
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.date).toBe('2026-07-13')
    expect(entries[0]?.lines).toEqual(['- Work A'])
    expect(entries[1]?.date).toBe('2026-07-09')
  })

  it('does not let a month line corrupt the preceding entry', () => {
    const body = [
      '- 2026-07',
      '    - 2026-07-13',
      '        - Work A',
      '- 2026-06',
      '    - 2026-06-30',
      '        - Work B',
    ].join('\n')
    const entries = parseLogBody(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.lines).toEqual(['- Work A'])
    expect(entries[1]?.lines).toEqual(['- Work B'])
  })
})

// ---------------------------------------------------------------------------
// groupLogByMonth
// ---------------------------------------------------------------------------

describe('groupLogByMonth', () => {
  it('groups a flat list-mode body spanning multiple months', () => {
    const body = [
      '- 2026-07-13',
      '    - Work A',
      '- 2026-07-09',
      '    - Work B',
      '- 2026-06-30',
      '    - Work C',
    ].join('\n')
    const result = groupLogByMonth(body, listSettings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe([
      '- 2026-07',
      '    - 2026-07-13',
      '        - Work A',
      '    - 2026-07-09',
      '        - Work B',
      '- 2026-06',
      '    - 2026-06-30',
      '        - Work C',
      '',
    ].join('\n'))
  })

  it('groups a flat heading-mode body without indenting day headings or content', () => {
    const body = [
      '###### 2026-07-13',
      '- Work A',
      '###### 2026-07-09',
      '- Work B',
      '###### 2026-06-30',
      '- Work C',
    ].join('\n')
    const result = groupLogByMonth(body, headingSettings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe([
      '##### 2026-07',
      '###### 2026-07-13',
      '- Work A',
      '###### 2026-07-09',
      '- Work B',
      '##### 2026-06',
      '###### 2026-06-30',
      '- Work C',
      '',
    ].join('\n'))
  })

  it('is idempotent for list mode', () => {
    const body = [
      '- 2026-07-13',
      '    - Work A',
      '- 2026-06-30',
      '    - Work C',
    ].join('\n')
    const first = groupLogByMonth(body, listSettings)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = groupLogByMonth(first.body, listSettings)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.body).toBe(first.body)
  })

  it('is idempotent for heading mode', () => {
    const body = [
      '###### 2026-07-13',
      '- Work A',
      '###### 2026-06-30',
      '- Work C',
    ].join('\n')
    const first = groupLogByMonth(body, headingSettings)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = groupLogByMonth(first.body, headingSettings)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.body).toBe(first.body)
  })

  it('refuses to group when logDateHeadingLevel is 1', () => {
    const settings = makeSettings({ logDateHeadingLevel: 1 })
    const body = '# 2026-07-13\n- Work A'
    const result = groupLogByMonth(body, settings)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/heading level/i)
  })

  it('uses an explicit month heading level when set', () => {
    const settings = makeSettings({ logDateHeadingLevel: 6, logMonthHeadingLevel: 2 })
    const body = '###### 2026-07-13\n- Work A'
    const result = groupLogByMonth(body, settings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe([
      '## 2026-07',
      '###### 2026-07-13',
      '- Work A',
      '',
    ].join('\n'))
  })

  it('refuses to group when the explicit month level is not shallower than the date level', () => {
    const settings = makeSettings({ logDateHeadingLevel: 3, logMonthHeadingLevel: 3 })
    const body = '### 2026-07-13\n- Work A'
    const result = groupLogByMonth(body, settings)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toMatch(/shallower/i)
  })

  it('preserves out-of-order entries without re-sorting', () => {
    const body = [
      '- 2026-06-30',
      '    - Older first',
      '- 2026-07-13',
      '    - Newer second',
    ].join('\n')
    const result = groupLogByMonth(body, listSettings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const idxJune = result.body.indexOf('2026-06')
    const idxJuly = result.body.indexOf('2026-07')
    expect(idxJune).toBeLessThan(idxJuly)
    expect(result.body.indexOf('Older first')).toBeLessThan(result.body.indexOf('2026-07'))
  })

  it('preserves a leading title heading', () => {
    const body = [
      '## Log',
      '- 2026-07-13',
      '    - Work A',
    ].join('\n')
    const result = groupLogByMonth(body, listSettings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body.startsWith('## Log\n')).toBe(true)
    expect(result.body).toContain('- 2026-07')
  })

  it('aborts without mutating when the body has ungroupable content', () => {
    const body = [
      'Some stray line that is not a title, date, or month',
      '- 2026-07-13',
      '    - Work A',
    ].join('\n')
    const result = groupLogByMonth(body, listSettings)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('stray line')
  })

  it('is a no-op on an empty body', () => {
    const result = groupLogByMonth('', listSettings)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.body).toBe('')
  })
})

// ---------------------------------------------------------------------------
// insertNoteIntoLog — grouped bodies
// ---------------------------------------------------------------------------

describe('insertNoteIntoLog with month groups', () => {
  const settings = listSettings

  it('appends into an existing day inside an existing month group', () => {
    const content = [
      ':::log',
      '- 2026-07',
      '    - 2026-07-13',
      '        - First',
      ':::',
    ].join('\n')
    const result = insertNoteIntoLog(content, '2026-07-13', 'Second', settings)!
    expect(result.content.indexOf('First')).toBeLessThan(result.content.indexOf('Second'))
    // Still only one month group.
    expect(result.content.match(/- 2026-07\n/g)).toHaveLength(1)
  })

  it('creates a new day inside an existing month group, in chronological position', () => {
    const content = [
      ':::log',
      '- 2026-07',
      '    - 2026-07-13',
      '        - First',
      ':::',
    ].join('\n')
    const result = insertNoteIntoLog(content, '2026-07-20', 'Newer', settings)!
    expect(result.content.indexOf('2026-07-20')).toBeLessThan(result.content.indexOf('2026-07-13'))
    // Still only one month group, both days nested under it.
    expect(result.content.match(/^- 2026-07$/m)).toHaveLength(1)
  })

  it('creates a new month group in chronological position', () => {
    const content = [
      ':::log',
      '- 2026-07',
      '    - 2026-07-13',
      '        - First',
      ':::',
    ].join('\n')
    const result = insertNoteIntoLog(content, '2026-06-01', 'Older month', settings)!
    const idxJuly = result.content.indexOf('- 2026-07')
    const idxJune = result.content.indexOf('- 2026-06')
    expect(idxJuly).toBeLessThan(idxJune)
    expect(result.content).toContain('Older month')
  })

  it('leaves a still-flat body flat (grouping is opt-in only)', () => {
    const content = ':::log\n- 2026-07-13\n    - First\n:::'
    const result = insertNoteIntoLog(content, '2026-07-09', 'New entry', settings)!
    expect(result.content).not.toMatch(/^- 2026-07$/m)
    expect(result.content).toContain('- 2026-07-13')
    expect(result.content).toContain('- 2026-07-09')
  })
})
