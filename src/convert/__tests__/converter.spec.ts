import { describe, expect, it } from 'vitest'

import { encodeMagicParagraph } from '@/graph/codec'
import { convertedMarkdown, convertPage, warningsComment } from '../converter'

/** a page as Graph returns it: head, absolutely positioned outlines in the body */
const page = (...outlines: string[]) => `<html lang="en-US">
 <head>
  <title>Test</title>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
 </head>
 <body data-absolute-enabled="true" style="font-family:Calibri;font-size:11pt">
  ${outlines.join('\n  ')}
 </body>
</html>`

const outline = (top: number, html: string, left = 48) =>
  `<div style="position:absolute;left:${left}px;top:${top}px;width:624px">\n   ${html}\n  </div>`

const P = (html: string, attrs = '') =>
  `<p ${attrs} style="margin-top:0pt;margin-bottom:0pt">${html}</p>`

describe('convertPage (C7)', () => {
  it('converts headings, paragraphs and inline styles', () => {
    const { markdown, warnings } = convertPage(
      page(
        outline(
          115,
          [
            '<h1 style="font-size:16pt;color:#1e4e79;font-weight:bold">Weekend</h1>',
            P(
              'Buy <span style="font-weight:bold">milk</span> and <span style="font-style:italic">eggs</span>',
            ),
            P(
              '<span style="text-decoration:line-through">old</span> <span style="font-weight:bold;font-style:italic">both</span>',
            ),
            P('run <span style="font-family:Consolas">npm test</span> first&nbsp;&nbsp;please'),
            P('colors <span style="color:red;text-decoration:underline">vanish</span>'),
          ].join('\n'),
        ),
      ),
    )
    expect(markdown).toBe(
      [
        '# Weekend',
        'Buy **milk** and *eggs*',
        '~~old~~ ***both***',
        'run `npm test` first  please',
        'colors vanish',
      ].join('\n\n'),
    )
    expect(warnings).toEqual([])
  })

  it('orders outlines by position', () => {
    const { markdown } = convertPage(
      page(outline(300, P('third')), outline(40, P('first')), outline(40, P('second'), 400)),
    )
    expect(markdown).toBe('first\n\nsecond\n\nthird')
  })

  it('keeps text as typed, markdown included', () => {
    const { markdown } = convertPage(
      page(outline(40, [P('# not a heading in OneNote'), P('snake_case and 1. items')].join(''))),
    )
    expect(markdown).toBe('# not a heading in OneNote\n\nsnake_case and 1. items')
  })

  it('converts to-dos and lists, nested the way OneNote nests them', () => {
    const { markdown, warnings } = convertPage(
      page(
        outline(
          40,
          [
            P('call mom', 'data-tag="to-do"'),
            P('pay rent', 'data-tag="to-do:completed"'),
            P('star', 'data-tag="important"'),
            '<ul><li>apples</li><ul><li>green</li><li>red</li></ul><li data-tag="to-do">pears</li></ul>',
            '<ol start="3"><li>three</li><li>four</li></ol>',
          ].join(''),
        ),
      ),
    )
    expect(markdown).toBe(
      [
        '- [ ] call mom\n- [x] pay rent',
        'star',
        '- apples\n  - green\n  - red\n- [ ] pears',
        '3. three\n4. four',
      ].join('\n\n'),
    )
    expect(warnings).toEqual(['tag'])
  })

  it('turns runs of monospace paragraphs into one code block', () => {
    const { markdown } = convertPage(
      page(
        outline(
          40,
          [
            P('Setup:'),
            P('<span style="font-family:Consolas">npm ci</span>'),
            P('<span style="font-family:\'Courier New\'">npm run   dev</span>'),
            P('done'),
          ].join(''),
        ),
      ),
    )
    expect(markdown).toBe('Setup:\n\n```\nnpm ci\nnpm run   dev\n```\n\ndone')
  })

  it('converts simple tables, keeps complex ones as HTML', () => {
    const simple =
      '<table border="1"><tr><td>Name</td><td>Qty</td></tr><tr><td><span style="font-weight:bold">milk</span></td><td>2 | 3</td></tr></table>'
    const complex = '<table><tr><td colspan="2">wide</td></tr><tr><td>a</td><td>b</td></tr></table>'
    const { markdown, warnings } = convertPage(page(outline(40, simple), outline(200, complex)))
    expect(markdown).toBe(
      `| Name | Qty |\n| --- | --- |\n| **milk** | 2 \\| 3 |\n\n${complex.replace('<tr>', '<tbody><tr>').replace('</table>', '</tbody></table>')}`,
    )
    expect(warnings).toEqual(['table'])
  })

  it('leaves placeholders and warnings for what it does not convert (C7.4, C7.6, C7.7)', () => {
    const img =
      '<img alt="cat" src="https://graph.microsoft.com/v1.0/me/onenote/resources/0-abc!1/$value" />'
    const att =
      '<object data-attachment="plan.pdf" type="application/pdf" data="https://graph.microsoft.com/v1.0/me/onenote/resources/0-def!2/$value"></object>'
    const link = '<a href="onenote:#Groceries&section-id=x">see list</a>'
    const { markdown, warnings } = convertPage(
      page(outline(40, P(img)), outline(80, P(att)), outline(120, P(link + ' <mark>hi</mark>'))),
    )
    expect(markdown).toBe(
      '![cat](onenote-resource:0-abc!1)\n\n[📎 plan.pdf](onenote-resource:0-def!2)\n\n[see list](onenote:#Groceries&section-id=x) hi',
    )
    expect(warnings).toEqual(['unknown:mark', 'attachment', 'onenote-link', 'image'])
  })

  it('decodes pages that already hold a magic paragraph', () => {
    const md = '# Hi\n\n- [ ] keep **markdown**'
    expect(convertPage(page(encodeMagicParagraph(md)))).toEqual({ markdown: md, warnings: [] })
  })

  it('is deterministic (C7.1)', () => {
    const html = page(
      outline(40, [P('a'), '<ul><li>b</li></ul>'].join('')),
      outline(10, P('<b>c</b>')),
    )
    expect(convertPage(html)).toEqual(convertPage(html))
  })
})

describe('warnings comment (C8)', () => {
  it('counts warnings in order of appearance', () => {
    expect(warningsComment(['table', 'image', 'table', 'unknown:mark'])).toBe(
      '<!-- ntyonenote convert: table kept as HTML (2), image not converted (1), <mark> kept as text (1) -->',
    )
    expect(warningsComment([])).toBe('')
  })

  it('goes on top of the page', () => {
    expect(convertedMarkdown({ markdown: 'text', warnings: ['tag'] })).toBe(
      '<!-- ntyonenote convert: note tag dropped (1) -->\n\ntext',
    )
    expect(convertedMarkdown({ markdown: 'text', warnings: [] })).toBe('text')
  })
})
