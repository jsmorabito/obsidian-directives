import { describe, it, expect } from 'vitest'
import { DATE_RE, extractDate, todayISO, buildDateLine, parseWhere, matchesFrontmatter, debounce } from '../core/utils'
import type { DirectivesSettings } from '../settings'
import { DEFAULT_SETTINGS } from '../settings'

// ---------------------------------------------------------------------------
// DATE_RE + extractDate
// ---------------------------------------------------------------------------

describe('DATE_RE', () => {
  it('matches plain list-item date', () => {
    expect(DATE_RE.exec('- 2026-06-23')).not.toBeNull()
  })

  it('matches heading date at levels 1-6', () => {
    for (let i = 1; i <= 6; i++) {
      expect(DATE_RE.exec(`${'#'.repeat(i)} 2026-06-23`)).not.toBeNull()
    }
  })

  it('matches wikilink date', () => {
    expect(DATE_RE.exec('- [[2026-06-23]]')).not.toBeNull()
  })

  it('matches wikilink date with path prefix', () => {
    expect(DATE_RE.exec('- [[Daily/2026-06-23]]')).not.toBeNull()
  })

  it('does not match plain text', () => {
    expect(DATE_RE.exec('some random text')).toBeNull()
  })

  it('does not match partial date', () => {
    expect(DATE_RE.exec('- 2026-06')).toBeNull()
  })
})

describe('extractDate', () => {
  it('extracts plain date', () => {
    const m = DATE_RE.exec('- 2026-06-23')!
    expect(extractDate(m)).toBe('2026-06-23')
  })

  it('extracts date from wikilink', () => {
    const m = DATE_RE.exec('- [[Daily/2026-06-23]]')!
    expect(extractDate(m)).toBe('2026-06-23')
  })
})

// ---------------------------------------------------------------------------
// todayISO
// ---------------------------------------------------------------------------

describe('todayISO', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

// ---------------------------------------------------------------------------
// buildDateLine
// ---------------------------------------------------------------------------

function makeSettings(overrides: Partial<DirectivesSettings> = {}): DirectivesSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('buildDateLine', () => {
  it('returns list-item style when level=0', () => {
    expect(buildDateLine('2026-06-23', makeSettings({ logDateHeadingLevel: 0 }))).toBe('- 2026-06-23')
  })

  it('returns H2 style when level=2', () => {
    expect(buildDateLine('2026-06-23', makeSettings({ logDateHeadingLevel: 2 }))).toBe('## 2026-06-23')
  })

  it('returns wikilink with default format', () => {
    const line = buildDateLine('2026-06-23', makeSettings({
      logDateStyle: 'wikilink',
      logDateFormat: '{{date}}',
      logDateHeadingLevel: 0,
    }))
    expect(line).toBe('- [[2026-06-23]]')
  })

  it('returns wikilink with custom path prefix', () => {
    const line = buildDateLine('2026-06-23', makeSettings({
      logDateStyle: 'wikilink',
      logDateFormat: 'Daily/{{date}}',
      logDateHeadingLevel: 0,
    }))
    expect(line).toBe('- [[Daily/2026-06-23]]')
  })

  it('returns heading wikilink', () => {
    const line = buildDateLine('2026-06-23', makeSettings({
      logDateStyle: 'wikilink',
      logDateFormat: '{{date}}',
      logDateHeadingLevel: 6,
    }))
    expect(line).toBe('###### [[2026-06-23]]')
  })
})

// ---------------------------------------------------------------------------
// parseWhere
// ---------------------------------------------------------------------------

describe('parseWhere', () => {
  it('returns empty for empty string', () => {
    expect(parseWhere('')).toEqual([])
    expect(parseWhere('   ')).toEqual([])
  })

  it('parses a single key=value condition', () => {
    expect(parseWhere('status=active')).toEqual([
      { key: 'status', values: ['active'] },
    ])
  })

  it('parses OR values separated by |', () => {
    expect(parseWhere('type=project|task')).toEqual([
      { key: 'type', values: ['project', 'task'] },
    ])
  })

  it('parses multiple comma-separated conditions', () => {
    const result = parseWhere('status=active, type=project')
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ key: 'status', values: ['active'] })
    expect(result[1]).toEqual({ key: 'type', values: ['project'] })
  })

  it('normalises values to lowercase', () => {
    expect(parseWhere('status=Active')).toEqual([
      { key: 'status', values: ['active'] },
    ])
  })

  it('skips malformed terms with no =', () => {
    expect(parseWhere('noequalssign')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// matchesFrontmatter
// ---------------------------------------------------------------------------

describe('matchesFrontmatter', () => {
  it('returns true when conditions list is empty', () => {
    expect(matchesFrontmatter(null, [])).toBe(true)
    expect(matchesFrontmatter({ status: 'active' }, [])).toBe(true)
  })

  it('returns false when frontmatter is null/undefined with conditions', () => {
    const conds = parseWhere('status=active')
    expect(matchesFrontmatter(null, conds)).toBe(false)
    expect(matchesFrontmatter(undefined, conds)).toBe(false)
  })

  it('matches a single string field', () => {
    const conds = parseWhere('status=active')
    expect(matchesFrontmatter({ status: 'active' }, conds)).toBe(true)
    expect(matchesFrontmatter({ status: 'inactive' }, conds)).toBe(false)
  })

  it('matches case-insensitively', () => {
    const conds = parseWhere('status=active')
    expect(matchesFrontmatter({ status: 'Active' }, conds)).toBe(true)
  })

  it('matches OR values', () => {
    const conds = parseWhere('type=project|task')
    expect(matchesFrontmatter({ type: 'project' }, conds)).toBe(true)
    expect(matchesFrontmatter({ type: 'task' }, conds)).toBe(true)
    expect(matchesFrontmatter({ type: 'note' }, conds)).toBe(false)
  })

  it('matches array frontmatter values (OR semantics)', () => {
    const conds = parseWhere('tags=work')
    expect(matchesFrontmatter({ tags: ['work', 'personal'] }, conds)).toBe(true)
    expect(matchesFrontmatter({ tags: ['personal'] }, conds)).toBe(false)
  })

  it('requires all conditions to match (AND semantics)', () => {
    const conds = parseWhere('status=active, type=project')
    expect(matchesFrontmatter({ status: 'active', type: 'project' }, conds)).toBe(true)
    expect(matchesFrontmatter({ status: 'active', type: 'task' }, conds)).toBe(false)
    expect(matchesFrontmatter({ status: 'done', type: 'project' }, conds)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// debounce
// ---------------------------------------------------------------------------

describe('debounce', () => {
  it('delays invocation', async () => {
    let count = 0
    const fn = debounce(() => { count++ }, 20)
    fn(); fn(); fn()
    expect(count).toBe(0)
    await new Promise(r => setTimeout(r, 30))
    expect(count).toBe(1)
  })

  it('resets the timer on each call', async () => {
    let count = 0
    const fn = debounce(() => { count++ }, 30)
    fn()
    await new Promise(r => setTimeout(r, 10))
    fn()
    await new Promise(r => setTimeout(r, 10))
    fn()
    await new Promise(r => setTimeout(r, 40))
    expect(count).toBe(1)
  })
})
