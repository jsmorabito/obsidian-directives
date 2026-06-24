import { describe, it, expect } from 'vitest'
import { parseDirectives, parseAttributes } from '../core/parser'

// ---------------------------------------------------------------------------
// parseAttributes
// ---------------------------------------------------------------------------

describe('parseAttributes', () => {
  it('returns empty object for empty string', () => {
    expect(parseAttributes('')).toEqual({})
    expect(parseAttributes('   ')).toEqual({})
  })

  it('parses unquoted key=value', () => {
    expect(parseAttributes('bpm=120')).toEqual({ bpm: '120' })
  })

  it('parses double-quoted value with spaces', () => {
    expect(parseAttributes('from="My Notes/file.md"')).toEqual({ from: 'My Notes/file.md' })
  })

  it('parses single-quoted value', () => {
    expect(parseAttributes("key='hello world'")).toEqual({ key: 'hello world' })
  })

  it('parses #id shortcut', () => {
    expect(parseAttributes('#myId')).toEqual({ id: 'myId' })
  })

  it('parses .class shortcut', () => {
    expect(parseAttributes('.foo')).toEqual({ class: 'foo' })
  })

  it('accumulates multiple .class values with space', () => {
    expect(parseAttributes('.foo .bar')).toEqual({ class: 'foo bar' })
  })

  it('parses bare boolean key', () => {
    expect(parseAttributes('autoplay')).toEqual({ autoplay: '' })
  })

  it('parses multiple attributes', () => {
    expect(parseAttributes('bpm=120 layout=grid #myId')).toEqual({
      bpm: '120',
      layout: 'grid',
      id: 'myId',
    })
  })
})

// ---------------------------------------------------------------------------
// parseDirectives
// ---------------------------------------------------------------------------

describe('parseDirectives', () => {
  it('returns empty for plain text', () => {
    expect(parseDirectives('just some text\nno directives here')).toEqual([])
  })

  it('parses a container directive with no body', () => {
    const doc = ':::log\n:::'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'container', name: 'log', body: '' })
  })

  it('parses a container directive with a body', () => {
    const doc = ':::audio{src=song.mp3}\n- 0:30 Verse\n- 1:00 Chorus\n:::'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'container',
      name: 'audio',
      attributes: { src: 'song.mp3' },
      body: '- 0:30 Verse\n- 1:00 Chorus',
    })
  })

  it('parses a container directive with a label', () => {
    const doc = ':::checklist[My Tasks]\n:::'
    const result = parseDirectives(doc)
    expect(result[0]).toMatchObject({ name: 'checklist', label: 'My Tasks' })
  })

  it('parses a leaf directive', () => {
    const doc = '::youtube[Tutorial]{vid=dQw4w9WgXcQ}'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'leaf', name: 'youtube', label: 'Tutorial', attributes: { vid: 'dQw4w9WgXcQ' } })
  })

  it('parses an inline text directive', () => {
    const doc = 'See :note[here] for details'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'text', name: 'note', label: 'here' })
  })

  it('does not parse ::: as an inline directive', () => {
    const doc = ':::log\n:::'
    const result = parseDirectives(doc)
    expect(result.every(d => d.type === 'container' || d.type === 'leaf')).toBe(true)
  })

  it('tracks from/to offsets correctly', () => {
    const doc = ':::log\nbody\n:::'
    const result = parseDirectives(doc)
    expect(result[0]?.from).toBe(0)
    expect(result[0]?.to).toBe(doc.length)
  })

  it('parses multiple directives', () => {
    const doc = ':::audio{src=a.mp3}\n:::\n\n:::chords\n:::'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(2)
    expect(result[0]?.name).toBe('audio')
    expect(result[1]?.name).toBe('chords')
  })

  it('handles unclosed container by consuming to end of doc', () => {
    const doc = ':::log\nsome content'
    const result = parseDirectives(doc)
    expect(result).toHaveLength(1)
    expect(result[0]?.to).toBe(doc.length)
  })
})
