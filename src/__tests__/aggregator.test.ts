import { describe, it, expect } from 'vitest'
import { parseTabDefs, applyFilter, collectMatchingLines } from '../handlers/aggregator'

// ---------------------------------------------------------------------------
// parseTabDefs
// ---------------------------------------------------------------------------

describe('parseTabDefs', () => {
  it('returns empty array when body has no ::tab lines', () => {
    expect(parseTabDefs('')).toEqual([])
    expect(parseTabDefs('just some content')).toEqual([])
  })

  it('parses a single tab with label and attrs', () => {
    const body = '::tab[Improvements]{from="#improvements"}'
    const tabs = parseTabDefs(body)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.label).toBe('Improvements')
    expect(tabs[0]?.attrs['from']).toBe('#improvements')
  })

  it('parses multiple tabs', () => {
    const body = '::tab[Bugs]{from="#bugs"}\n::tab[Features]{from="#features"}'
    const tabs = parseTabDefs(body)
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.label).toBe('Bugs')
    expect(tabs[1]?.label).toBe('Features')
  })

  it('uses "Tab" as default label when label is absent', () => {
    const tabs = parseTabDefs('::tab{from="#foo"}')
    expect(tabs[0]?.label).toBe('Tab')
  })

  it('parses tab with no attrs', () => {
    const tabs = parseTabDefs('::tab[My Tab]')
    expect(tabs[0]?.label).toBe('My Tab')
    expect(tabs[0]?.attrs).toEqual({})
  })

  it('ignores non-tab lines', () => {
    const body = 'some content\n::tab[Tab1]\nmore content\n::tab[Tab2]'
    const tabs = parseTabDefs(body)
    expect(tabs).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// applyFilter (aggregator)
// ---------------------------------------------------------------------------

describe('applyFilter (aggregator)', () => {
  const lines = [
    { text: '- [ ] Open task',    sourcePath: 'a.md', lineNumber: 0, offset: 0 },
    { text: '- [x] Done task',    sourcePath: 'a.md', lineNumber: 1, offset: 20 },
    { text: '~~Struck through~~', sourcePath: 'b.md', lineNumber: 0, offset: 0 },
    { text: 'Plain line',         sourcePath: 'b.md', lineNumber: 1, offset: 20 },
  ]

  it('all — returns all lines', () => {
    expect(applyFilter(lines, 'all')).toHaveLength(4)
  })

  it('hide-done — excludes checked and strikethrough lines', () => {
    const result = applyFilter(lines, 'hide-done')
    expect(result.map(l => l.text)).not.toContain('- [x] Done task')
    expect(result.map(l => l.text)).not.toContain('~~Struck through~~')
    expect(result).toHaveLength(2)
  })

  it('only-done — returns only checked and strikethrough lines', () => {
    const result = applyFilter(lines, 'only-done')
    expect(result.map(l => l.text)).toContain('- [x] Done task')
    expect(result.map(l => l.text)).toContain('~~Struck through~~')
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// collectMatchingLines
// ---------------------------------------------------------------------------

describe('collectMatchingLines', () => {
  it('returns lines containing the regex', () => {
    const content = 'first line\nhas #tag here\nno match\nalso #tag'
    const re = /#tag(?=[\s,;.!?\])]|$)/i
    const lines = collectMatchingLines(content, 'test.md', re)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.text).toBe('has #tag here')
    expect(lines[1]?.text).toBe('also #tag')
  })

  it('skips empty lines', () => {
    const content = '\n#tag\n\n'
    const re = /#tag/i
    const lines = collectMatchingLines(content, 'test.md', re)
    expect(lines).toHaveLength(1)
  })

  it('records lineNumber correctly', () => {
    const content = 'no match\n#tag line'
    const re = /#tag/i
    const lines = collectMatchingLines(content, 'test.md', re)
    expect(lines[0]?.lineNumber).toBe(1)
  })

  it('records sourcePath', () => {
    const lines = collectMatchingLines('#tag', 'notes/work.md', /#tag/i)
    expect(lines[0]?.sourcePath).toBe('notes/work.md')
  })

  it('records offset as cumulative character position', () => {
    const content = 'line one\n#tag'  // "line one\n" = 9 chars
    const re = /#tag/i
    const lines = collectMatchingLines(content, 'test.md', re)
    expect(lines[0]?.offset).toBe(9)
  })
})
