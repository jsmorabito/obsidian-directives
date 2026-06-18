/**
 * parser.ts
 *
 * CodeMirror 6 StateField that parses the editor document for directive blocks
 * on every document change and makes the result available to the Decoration
 * Engine and to handler code.
 *
 * Design decision (from spec §10.1): state field rather than Lezer grammar.
 * Simpler to implement and debug; a Lezer grammar can replace this in v2 if
 * performance demands it.
 */

import { StateField } from '@codemirror/state'
import type { Transaction } from '@codemirror/state'
import type { ParsedDirective } from '../types'

// ---------------------------------------------------------------------------
// Public state field
// ---------------------------------------------------------------------------

/**
 * A CodeMirror StateField holding the list of directives parsed from the
 * current document. Re-computed on every document change.
 */
export const directivesField = StateField.define<ParsedDirective[]>({
  create(state) {
    return parseDirectives(state.doc.toString())
  },

  update(directives: ParsedDirective[], tr: Transaction): ParsedDirective[] {
    if (!tr.docChanged) return directives
    return parseDirectives(tr.state.doc.toString())
  },
})

// ---------------------------------------------------------------------------
// Directive name pattern
// ---------------------------------------------------------------------------

/**
 * Valid directive name: starts with a letter, may contain letters, digits,
 * hyphens, and underscores.
 */
const NAME = '[a-zA-Z][\\w\\-]*'

// Opening container line:  :::+  name  [label]?  {attrs}?
const CONTAINER_OPEN_RE = new RegExp(
  `^(:{3,})(${NAME})(\\[([^\\]]*)\\])?(\\{([^}]*)\\})?\\s*$`,
)

// Leaf line (exactly two colons, lookahead excludes :::+):
//   ::  name  [label]?  {attrs}?
const LEAF_RE = new RegExp(
  `^::(?!:)(${NAME})(\\[([^\\]]*)\\])?(\\{([^}]*)\\})?\\s*$`,
)

// Inline text directive used in line-scan:
//   :name  [label]?  {attrs}?
const TEXT_RE = new RegExp(
  `:(${NAME})(\\[([^\\]]*)\\])?(\\{([^}]*)\\})?`,
  'g',
)

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

export function parseDirectives(docText: string): ParsedDirective[] {
  const directives: ParsedDirective[] = []

  // Build a line index: lines[i] = text, lineOffsets[i] = char offset in doc.
  const rawLines = docText.split('\n')
  const lines: string[] = rawLines
  const lineOffsets: number[] = []
  {
    let off = 0
    for (const l of lines) {
      lineOffsets.push(off)
      off += l.length + 1 // +1 for '\n'
    }
  }

  function lineAt(idx: number): string {
    return lines[idx] ?? ''
  }

  function offsetAt(idx: number): number {
    return lineOffsets[idx] ?? docText.length
  }

  let i = 0
  while (i < lines.length) {
    const line = lineAt(i)
    const lineStart = offsetAt(i)

    // ------------------------------------------------------------------
    // 1. Container directive  (:::name ... :::)
    // ------------------------------------------------------------------
    const containerMatch = CONTAINER_OPEN_RE.exec(line)
    if (containerMatch !== null) {
      const fence    = containerMatch[1] ?? ':::'
      const name     = containerMatch[2] ?? ''
      const label    = containerMatch[4]   // group 4: inside [], may be undefined
      const attrsRaw = containerMatch[6]   // group 6: inside {}, may be undefined

      // Closing fence: same number of colons on a line by itself.
      const closingFence = new RegExp(`^:{${fence.length}}\\s*$`)

      // Collect body lines until closing fence or end of document.
      const bodyLines: string[] = []
      let j = i + 1
      while (j < lines.length && !closingFence.test(lineAt(j))) {
        bodyLines.push(lineAt(j))
        j++
      }

      // `to` includes the closing fence line (or end of doc when unclosed).
      let to: number
      if (j < lines.length) {
        const closingLineText = lineAt(j)
        to = offsetAt(j) + closingLineText.length
      } else {
        to = docText.length
      }

      directives.push({
        type: 'container',
        name,
        label,
        attributes: parseAttributes(attrsRaw ?? ''),
        body: bodyLines.join('\n'),
        from: lineStart,
        to,
      })

      i = j + 1
      continue
    }

    // ------------------------------------------------------------------
    // 2. Leaf directive  (::name)
    // ------------------------------------------------------------------
    const leafMatch = LEAF_RE.exec(line)
    if (leafMatch !== null) {
      const name     = leafMatch[1] ?? ''
      const label    = leafMatch[3]   // may be undefined
      const attrsRaw = leafMatch[5]   // may be undefined

      directives.push({
        type: 'leaf',
        name,
        label,
        attributes: parseAttributes(attrsRaw ?? ''),
        body: undefined,
        from: lineStart,
        to: lineStart + line.length,
      })

      i++
      continue
    }

    // ------------------------------------------------------------------
    // 3. Text directives  (:name within a line)
    //    Skip lines that start with colons — already handled above (or
    //    are plain colons/fences which we don't want to scan inside).
    // ------------------------------------------------------------------
    if (!line.startsWith(':')) {
      TEXT_RE.lastIndex = 0
      let textMatch: RegExpExecArray | null
      while ((textMatch = TEXT_RE.exec(line)) !== null) {
        const matchIndex = textMatch.index

        // Reject if the character immediately before the leading colon is
        // also a colon — that would be part of a :: / ::: block.
        if (matchIndex > 0 && line[matchIndex - 1] === ':') continue

        const name     = textMatch[1] ?? ''
        const label    = textMatch[3]   // may be undefined
        const attrsRaw = textMatch[5]   // may be undefined
        const from     = lineStart + matchIndex
        const to       = from + textMatch[0].length

        directives.push({
          type: 'text',
          name,
          label,
          attributes: parseAttributes(attrsRaw ?? ''),
          body: undefined,
          from,
          to,
        })
      }
    }

    i++
  }

  return directives
}

// ---------------------------------------------------------------------------
// Attribute parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw attribute string (the contents of `{}`) into a key/value map.
 *
 * Supported forms:
 *   key=value          → { key: "value" }
 *   key="quoted val"   → { key: "quoted val" }
 *   key='single'       → { key: "single" }
 *   #myId              → { id: "myId" }
 *   .myClass           → { class: "myClass" }  (multiple classes are joined)
 *   boolKey            → { boolKey: "" }
 */
export function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  if (!raw.trim()) return attrs

  // Each branch of the alternation is mutually exclusive.
  const TOKEN_RE =
    /([a-zA-Z][\w-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|#([\w-]+)|\.([a-zA-Z][\w-]*)|([a-zA-Z][\w-]*)/g

  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      // key=value  (double-quoted, single-quoted, or unquoted)
      attrs[m[1]] = m[2] ?? m[3] ?? m[4] ?? ''
    } else if (m[5] !== undefined) {
      // #id shortcut
      attrs['id'] = m[5]
    } else if (m[6] !== undefined) {
      // .class shortcut — multiple classes are accumulated with a space
      const prev = attrs['class']
      attrs['class'] = prev !== undefined ? `${prev} ${m[6]}` : m[6]
    } else if (m[7] !== undefined) {
      // bare boolean key  (no value)
      attrs[m[7]] = ''
    }
  }

  return attrs
}
