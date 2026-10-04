import TurndownService from 'turndown'

import { extractMagicContent, MAGIC_DATA_ID } from '@/graph/codec'

// OneNote page HTML -> markdown, see docs/convert-design.md (C7).
// Deterministic: the same HTML always gives the same markdown (C7.1).

/** what the converter couldn't carry over, one entry per occurrence (C8) */
export type Warning =
  'tag' | 'onenote-link' | 'table' | 'image' | 'attachment' | 'embed' | `unknown:${string}`

export interface Conversion {
  markdown: string
  warnings: Warning[]
}

const KNOWN_TAGS = new Set(
  'html head title meta body div span p br a b strong i em u s del strike sub sup cite code pre img object iframe ul ol li table thead tbody tfoot tr td th h1 h2 h3 h4 h5 h6'.split(
    ' ',
  ),
)
const MONOSPACE = /consolas|courier|monospace|lucida console|menlo|monaco/i
const TODO = 'data-ntyonenote-todo'
const CODE = 'data-ntyonenote-code'
const PLACEHOLDER_SCHEME = 'onenote-resource:'

interface InlineStyle {
  bold: boolean
  italic: boolean
  strike: boolean
  mono: boolean
}

function styleOf(el: Element): InlineStyle {
  const style = (el.getAttribute('style') ?? '').toLowerCase()
  const value = (name: string) =>
    new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style)?.[1]?.trim() ?? ''
  const weight = value('font-weight')
  return {
    bold: weight === 'bold' || weight === 'bolder' || Number(weight) >= 600,
    italic: value('font-style') === 'italic',
    strike: value('text-decoration').includes('line-through'),
    mono: MONOSPACE.test(value('font-family')),
  }
}

/** every non-blank text in el is set in a monospace font */
function isMonospace(el: Element): boolean {
  const doc = el.ownerDocument
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let any = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.replace(/\u00a0/g, ' ').trim()) continue
    any = true
    let mono = false
    for (let p = node.parentElement; p && !mono; p = p === el ? null : p.parentElement)
      mono = styleOf(p).mono
    if (!mono) return false
  }
  return any
}

/** wraps el's children into <strong>/<em>/<del>/<code> as its inline style says */
function wrapChildren(el: Element, style: InlineStyle, inlineCode: boolean) {
  const doc = el.ownerDocument
  const tags = [
    style.bold && !/^H\d$/.test(el.nodeName) && 'strong',
    style.italic && 'em',
    style.strike && 'del',
    style.mono && inlineCode && 'code',
  ].filter((t): t is string => !!t)
  if (!tags.length || !el.childNodes.length) return
  const outer = doc.createElement(tags[0]!)
  let inner = outer
  for (const tag of tags.slice(1)) inner = inner.appendChild(doc.createElement(tag))
  while (el.firstChild) inner.appendChild(el.firstChild)
  el.appendChild(outer)
}

function textWithBreaks(el: Element): string {
  let text = ''
  el.childNodes.forEach((child) => {
    if (child.nodeName === 'BR') text += '\n'
    else if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
    else if (child.nodeType === Node.ELEMENT_NODE) text += textWithBreaks(child as Element)
  })
  return text.replace(/\u00a0/g, ' ')
}

/** OneNote's HTML -> plain semantic HTML that Turndown understands */
function normalize(body: HTMLElement, warn: (w: Warning) => void) {
  const doc = body.ownerDocument

  for (const el of Array.from(body.querySelectorAll('*'))) {
    const tag = el.nodeName.toLowerCase()
    if (!KNOWN_TAGS.has(tag)) warn(`unknown:${tag}`)
  }

  for (const el of Array.from(body.querySelectorAll('[data-tag]'))) {
    const tags = (el.getAttribute('data-tag') ?? '').split(',').map((t) => t.trim())
    if (tags.includes('to-do:completed')) el.setAttribute(TODO, 'done')
    else if (tags.includes('to-do')) el.setAttribute(TODO, 'open')
    if (tags.some((t) => !t.startsWith('to-do'))) warn('tag')
  }

  // Turndown drops empty elements, so attachments become their placeholder text right here
  for (const object of Array.from(body.querySelectorAll('object'))) {
    warn('attachment')
    const name = object.getAttribute('data-attachment') ?? 'attachment'
    const id = resourceId(object.getAttribute('data') ?? '')
    object.replaceWith(doc.createTextNode(`[📎 ${name}](${PLACEHOLDER_SCHEME}${id})`))
  }

  for (const a of Array.from(body.querySelectorAll('a[href]'))) {
    if (a.getAttribute('href')!.startsWith('onenote:')) warn('onenote-link')
  }

  // paragraphs set entirely in a monospace font are code, consecutive ones form one block
  for (const p of Array.from(body.querySelectorAll('p'))) {
    if (!p.hasAttribute(TODO) && isMonospace(p)) p.setAttribute(CODE, '')
  }
  for (const p of Array.from(body.querySelectorAll(`p[${CODE}]`))) {
    if (!p.isConnected) continue
    const run = [p]
    let next = p.nextElementSibling
    while (next?.matches(`p[${CODE}]`)) {
      run.push(next)
      next = next.nextElementSibling
    }
    const pre = doc.createElement('pre')
    pre.appendChild(doc.createElement('code')).textContent = run.map(textWithBreaks).join('\n')
    p.replaceWith(pre)
    run.slice(1).forEach((el) => el.remove())
  }

  // inline styles -> tags; spans are unwrapped, blocks keep their element
  for (const el of Array.from(body.querySelectorAll('[style]')).reverse()) {
    if (el.closest('pre')) continue
    wrapChildren(el, styleOf(el), true)
    if (el.nodeName === 'SPAN') el.replaceWith(...Array.from(el.childNodes))
  }

  // OneNote nests lists as siblings of items: move them into the item before
  for (const list of Array.from(body.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol'))) {
    const item = list.previousElementSibling
    if (item?.nodeName === 'LI') item.appendChild(list)
  }
}

function isSimpleTable(table: Element): boolean {
  if (
    table.querySelector(
      'table, ul, ol, pre, [colspan]:not([colspan="1"]), [rowspan]:not([rowspan="1"])',
    )
  )
    return false
  return Array.from(table.querySelectorAll('td, th')).every(
    (cell) => cell.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6').length <= 1,
  )
}

function resourceId(url: string): string {
  return /\/resources\/([^/]+)\//.exec(url)?.[1] ?? url
}

function createTurndown(warn: (w: Warning) => void): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    br: '\\',
  })
  // text is kept as typed: old notes often contain markdown written by hand (C7.3)
  td.escape = (text) => text

  td.addRule('strikethrough', {
    filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.nodeName),
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  })

  td.addRule('todo', {
    filter: (node) => node.nodeName !== 'LI' && node.hasAttribute(TODO),
    replacement: (content, node) => {
      const done = (node as Element).getAttribute(TODO) === 'done'
      return `\n\n- [${done ? 'x' : ' '}] ${content.trim()}\n\n`
    },
  })

  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
      const item = node as Element
      const parent = item.parentElement
      let marker = '- '
      if (parent?.nodeName === 'OL') {
        const start = Number(parent.getAttribute('start') ?? 1)
        marker = `${start + Array.from(parent.children).indexOf(item)}. `
      }
      const todo = item.getAttribute(TODO)
      const box = todo ? (todo === 'done' ? '[x] ' : '[ ] ') : ''
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, '\n' + ' '.repeat(marker.length))
      return marker + box + body + (item.nextElementSibling && !body.endsWith('\n') ? '\n' : '')
    },
  })

  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as Element
      if (!isSimpleTable(table)) {
        warn('table')
        return `\n\n${table.outerHTML}\n\n`
      }
      const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.children).map((cell) =>
          td
            .turndown(cell as HTMLElement)
            .replace(/\s*\n+\s*/g, ' ')
            .replace(/\|/g, '\\|'),
        ),
      )
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]) =>
        `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
      const separator = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`
      return `\n\n${[line(rows[0]!), separator, ...rows.slice(1).map(line)].join('\n')}\n\n`
    },
  })

  td.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      warn('image')
      const img = node as Element
      const src = img.getAttribute('data-fullres-src') ?? img.getAttribute('src') ?? ''
      return `![${img.getAttribute('alt') ?? ''}](${PLACEHOLDER_SCHEME}${resourceId(src)})`
    },
  })

  td.addRule('embed', {
    filter: 'iframe',
    replacement: (_content, node) => {
      warn('embed')
      const frame = node as Element
      const src = frame.getAttribute('data-original-src') ?? frame.getAttribute('src') ?? ''
      return `[embed](${src})`
    },
  })

  return td
}

/** top/left in px from an absolutely positioned element's style, null when absent */
function position(el: Element, name: 'top' | 'left'): number | null {
  const match = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*(-?[\\d.]+)px`).exec(
    el.getAttribute('style') ?? '',
  )
  return match ? Number(match[1]) : null
}

/** body's blocks in reading order: OneNote outlines by top, then left (C7.2) */
function readingOrder(body: HTMLElement): Element[] {
  const doc = body.ownerDocument
  const blocks: { el: Element; top: number; left: number; index: number }[] = []
  let lastTop = 0
  body.childNodes.forEach((node, index) => {
    let el: Element
    if (node.nodeType === Node.ELEMENT_NODE) el = node as Element
    else if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      el = doc.createElement('p')
      el.textContent = node.textContent
    } else return
    const top = position(el, 'top') ?? lastTop
    lastTop = top
    blocks.push({ el, top, left: position(el, 'left') ?? 0, index })
  })
  return blocks
    .sort((a, b) => a.top - b.top || a.left - b.left || a.index - b.index)
    .map((b) => b.el)
}

function tidy(markdown: string): string {
  return markdown
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^(- \[[ x]\] .*)\n\n(?=- \[[ x]\] )/gm, '$1\n')
    .trim()
}

/** One page's HTML (as Graph returns it, without includeIDs) to markdown */
export function convertPage(html: string): Conversion {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  // an _md page moved into a regular section: it's markdown already
  if (doc.querySelector(`p[data-id="${MAGIC_DATA_ID}"]`))
    return { markdown: extractMagicContent(html).markdown, warnings: [] }

  const warnings: Warning[] = []
  const warn = (w: Warning) => void warnings.push(w)
  normalize(doc.body, warn)
  const td = createTurndown(warn)
  const parts = readingOrder(doc.body).map((el) => td.turndown(el as HTMLElement))
  return { markdown: tidy(parts.filter((p) => p.trim()).join('\n\n')), warnings }
}

const LABELS: Record<string, string> = {
  table: 'table kept as HTML',
  image: 'image not converted',
  attachment: 'attachment not converted',
  embed: 'embed kept as a link',
  'onenote-link': 'OneNote link kept as is',
  tag: 'note tag dropped',
}

/** The warnings comment at the top of a converted page (C8), empty without warnings */
export function warningsComment(warnings: Warning[]): string {
  const counts = new Map<string, number>()
  for (const w of warnings) counts.set(w, (counts.get(w) ?? 0) + 1)
  if (!counts.size) return ''
  const parts = [...counts].map(
    ([w, n]) => `${LABELS[w] ?? `<${w.slice('unknown:'.length)}> kept as text`} (${n})`,
  )
  return `<!-- ntyonenote convert: ${parts.join(', ')} -->`
}

/** The page as committed and uploaded: warnings comment, then the markdown */
export function convertedMarkdown({ markdown, warnings }: Conversion): string {
  const comment = warningsComment(warnings)
  return comment ? `${comment}\n\n${markdown}` : markdown
}
