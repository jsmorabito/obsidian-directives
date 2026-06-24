import { describe, it, expect } from 'vitest'
import { parseTasks, applyFilter } from '../handlers/checklist'

// ---------------------------------------------------------------------------
// parseTasks
// ---------------------------------------------------------------------------

describe('parseTasks', () => {
  it('returns empty array for empty content', () => {
    expect(parseTasks('', null)).toEqual([])
  })

  it('parses an unchecked task', () => {
    const tasks = parseTasks('- [ ] Buy milk', null)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.checked).toBe(false)
    expect(tasks[0]?.text).toBe('Buy milk')
  })

  it('parses a checked task with lowercase x', () => {
    const tasks = parseTasks('- [x] Done thing', null)
    expect(tasks[0]?.checked).toBe(true)
  })

  it('parses a checked task with uppercase X', () => {
    const tasks = parseTasks('- [X] Done thing', null)
    expect(tasks[0]?.checked).toBe(true)
  })

  it('skips tasks with empty text', () => {
    const tasks = parseTasks('- [ ] \n- [ ] Real task', null)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.text).toBe('Real task')
  })

  it('records sourcePath', () => {
    const tasks = parseTasks('- [ ] Task', 'notes/work.md')
    expect(tasks[0]?.sourcePath).toBe('notes/work.md')
  })

  it('records null sourcePath for inline tasks', () => {
    const tasks = parseTasks('- [ ] Task', null)
    expect(tasks[0]?.sourcePath).toBeNull()
  })

  it('tracks lineNumber correctly', () => {
    const content = 'Some text\n- [ ] Task on line 2\n- [ ] Task on line 3'
    const tasks = parseTasks(content, null)
    expect(tasks[0]?.lineNumber).toBe(1)
    expect(tasks[1]?.lineNumber).toBe(2)
  })

  it('computes checkboxOffset correctly (offset of [ ])', () => {
    // "- [ ] Task" → offset 3 is '[' (0-based: '- '=2, then '[')
    const tasks = parseTasks('- [ ] Task', null)
    expect(tasks[0]?.checkboxOffset).toBe(3)
  })

  it('computes textOffset correctly (offset of task text start)', () => {
    // "- [ ] Task" → offset 6 is 'T'
    const tasks = parseTasks('- [ ] Task', null)
    expect(tasks[0]?.textOffset).toBe(6)
  })

  it('tracks directiveContext when inside a directive block', () => {
    const content = ':::log\n- [ ] Task inside log\n:::'
    const tasks = parseTasks(content, null)
    expect(tasks[0]?.directiveContext).toBe('log')
  })

  it('tracks null directiveContext for top-level tasks', () => {
    const tasks = parseTasks('- [ ] Top level task', null)
    expect(tasks[0]?.directiveContext).toBeNull()
  })

  it('tracks directiveLabel from opening fence', () => {
    const content = ':::log[My Journal]\n- [ ] Task\n:::'
    const tasks = parseTasks(content, null)
    expect(tasks[0]?.directiveLabel).toBe('My Journal')
  })

  it('parses multiple tasks across multiple lines', () => {
    const content = '- [ ] A\n- [x] B\n- [ ] C'
    const tasks = parseTasks(content, null)
    expect(tasks).toHaveLength(3)
    expect(tasks.map(t => t.text)).toEqual(['A', 'B', 'C'])
  })

  it('accumulates correct offsets for tasks on later lines', () => {
    const line1 = '- [ ] First\n'   // length 12
    const line2 = '- [ ] Second'
    const content = line1 + line2
    const tasks = parseTasks(content, null)
    expect(tasks[1]?.checkboxOffset).toBe(line1.length + 3)
  })
})

// ---------------------------------------------------------------------------
// applyFilter
// ---------------------------------------------------------------------------

describe('applyFilter (checklist)', () => {
  const tasks = [
    { checked: false, text: 'A', sourcePath: null, checkboxOffset: 0, textOffset: 0, lineLength: 0, lineNumber: 0, directiveContext: null, directiveLabel: null },
    { checked: true,  text: 'B', sourcePath: null, checkboxOffset: 0, textOffset: 0, lineLength: 0, lineNumber: 0, directiveContext: null, directiveLabel: null },
    { checked: false, text: 'C', sourcePath: null, checkboxOffset: 0, textOffset: 0, lineLength: 0, lineNumber: 0, directiveContext: null, directiveLabel: null },
  ]

  it('all — returns every task', () => {
    expect(applyFilter(tasks, 'all')).toHaveLength(3)
  })

  it('todo — returns only unchecked tasks', () => {
    const result = applyFilter(tasks, 'todo')
    expect(result).toHaveLength(2)
    expect(result.every(t => !t.checked)).toBe(true)
  })

  it('done — returns only checked tasks', () => {
    const result = applyFilter(tasks, 'done')
    expect(result).toHaveLength(1)
    expect(result[0]?.text).toBe('B')
  })
})
