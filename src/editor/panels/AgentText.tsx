import type { ReactNode } from 'react'

/**
 * Renders an agent reply as readable blocks: paragraphs, headings, bullet and
 * numbered lists, fenced code, and inline `code` and **bold**. Builds React
 * elements only (no HTML), so reply text can never inject markup.
 */
type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const FENCE = /^\s*```/
const HEADING = /^#{1,6}\s+(.*)$/

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      flush()
      const body: string[] = []
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i])
      out.push({ kind: 'code', text: body.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const heading = line.match(HEADING)
    if (heading) {
      flush()
      out.push({ kind: 'h', text: heading[1] })
      continue
    }
    const ordered = NUMBERED.test(line)
    const item = ordered ? NUMBERED : BULLET
    if (item.test(line)) {
      flush()
      const items: string[] = []
      for (; i < lines.length; i++) {
        const m = lines[i].match(item)
        if (m) items.push(m[1])
        else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += '\n' + lines[i].trim()
        else break
      }
      i--
      out.push({ kind: ordered ? 'ol' : 'ul', items })
      continue
    }
    para.push(line)
  }
  flush()
  return out
}

/** Inline `code` and **bold**. Odd split indexes are the matches. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((part, i) => {
    if (i % 2 === 0) return part
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    return <strong key={i}>{part.slice(2, -2)}</strong>
  })
}

export function AgentText({ text }: { text: string }) {
  return (
    <div className="k-md">
      {parseBlocks(text).map((b, i) => {
        switch (b.kind) {
          case 'p':
            return <p key={i}>{inline(b.text)}</p>
          case 'h':
            return <p key={i} className="k-md-h">{inline(b.text)}</p>
          case 'code':
            return <pre key={i}><code>{b.text}</code></pre>
          case 'ul':
            return <ul key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>
          case 'ol':
            return <ol key={i}>{b.items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ol>
        }
      })}
    </div>
  )
}
