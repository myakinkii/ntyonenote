import { describe, it, expect } from 'vitest'

import { encodeMarkdown, encodeMagicParagraph, extractMagicContent } from '../codec'
// real page html returned by Graph after PATCHing the markdown below
import welcomeHtml from './fixtures/welcome-br.html?raw'
import tortureHtml from './fixtures/torture.html?raw'

const WELCOME = `# Welcome from Claude 👋

Hello from the **ntyonenote** md client!

- line one
- line two
- line three

> Line breaks, please survive.`

const TORTURE =
  '# Torture\n\n\n\nthree blanks above\n- a\n    - nested 4sp\n\tTAB line\nmid  two   spaces\n' +
  'trailing hard break  \n```\ncode\n\n  indented code\n```\n<b>not html</b> & co'

describe('encodeMarkdown', () => {
  it('turns newlines into <br/> and escapes html', () => {
    expect(encodeMarkdown('a\n<b>&')).toBe('a<br/>&lt;b&gt;&amp;')
  })

  it('protects edge spaces and space runs with nbsp', () => {
    expect(encodeMarkdown('  x  y z ')).toBe('  x  y z ')
  })

  it('expands tabs since OneNote collapses them', () => {
    expect(encodeMarkdown('\tx')).toBe(' '.repeat(4) + 'x')
  })

  it('wraps into the magic paragraph', () => {
    expect(encodeMagicParagraph('x')).toBe('<p data-id="markdown-content">x</p>')
  })
})

describe('extractMagicContent', () => {
  it('decodes blank lines from U+FFFC markers', () => {
    const { id, markdown } = extractMagicContent(welcomeHtml)
    expect(id).toBe('p:{f4b61092-628c-4448-b331-bfeeff593f23}{42}')
    expect(markdown).toBe(WELCOME)
  })

  it('round-trips indentation, blank runs and escaping', () => {
    // fixture was sent with a raw tab, which OneNote ate - hence encodeMarkdown expands tabs
    expect(extractMagicContent(tortureHtml).markdown).toBe(TORTURE.replace('\t', ''))
  })

  it('reports pages without a magic paragraph', () => {
    expect(extractMagicContent('<html><body><p>hi</p></body></html>')).toEqual({
      id: null,
      markdown: '',
    })
  })
})
