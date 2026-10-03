// Markdown <-> OneNote "magic paragraph" codec.
//
// OneNote normalizes page HTML on its side, so markdown has to pretend to be
// plain text living in a single <p data-id="markdown-content">. Observed rules:
//  - raw "\n" collapses into a space, so every newline is sent as <br/>
//  - an empty line comes back as a leading U+FFFC on the next line (one per empty line)
//  - responses are pretty-printed: "\n" after each <br />, "\t\t\t" before it
//  - &nbsp; survives, so leading/trailing spaces and space runs are sent as nbsp
//  - tabs collapse into a single space, so they are expanded to spaces up front

export const MAGIC_DATA_ID = 'markdown-content'

const NBSP = ' '
const EMPTY_LINE_MARK = '￼'
const TAB_SPACES = '    '

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function encodeLine(line: string): string {
  const spaced = line.replace(/\t/g, TAB_SPACES)
  // protect spaces html would collapse or trim: at line edges and inside runs
  return escapeHtml(spaced).replace(/(?<= ) | (?= )|^ | $/g, NBSP)
}

/** Inner html for the magic paragraph */
export function encodeMarkdown(md: string): string {
  return md.replace(/\r\n?/g, '\n').split('\n').map(encodeLine).join('<br/>')
}

/** Whole magic paragraph element, ready for a PATCH replace/append */
export function encodeMagicParagraph(md: string): string {
  return `<p data-id="${MAGIC_DATA_ID}">${encodeMarkdown(md)}</p>`
}

/** Decode the magic paragraph element (parsed from html exactly as Graph returns it) */
export function decodeMagicParagraph(p: Element): string {
  const lines: string[] = []
  let current = ''
  const flush = () => {
    lines.push(current)
    current = ''
  }
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) current += child.textContent ?? ''
      else if (child.nodeName === 'BR') flush()
      else walk(child)
    })
  }
  walk(p)
  flush()

  const md: string[] = []
  for (const raw of lines) {
    // regular whitespace at line edges is formatting noise, real spaces were sent as nbsp
    let line = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    while (line.startsWith(EMPTY_LINE_MARK)) {
      md.push('')
      line = line.slice(1)
    }
    md.push(line.replaceAll(NBSP, ' '))
  }
  return md.join('\n')
}

export interface MagicContent {
  /** element id to target with PATCH, null when the page has no magic paragraph yet */
  id: string | null
  markdown: string
}

/** Find the magic paragraph in a page html (fetched with includeIDs=true) */
export function extractMagicContent(pageHtml: string): MagicContent {
  const doc = new DOMParser().parseFromString(pageHtml, 'text/html')
  const p = doc.querySelector(`p[data-id="${MAGIC_DATA_ID}"]`)
  if (!p) return { id: null, markdown: '' }
  return { id: p.getAttribute('id'), markdown: decodeMagicParagraph(p) }
}
