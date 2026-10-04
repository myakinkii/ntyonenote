import { describe, expect, it } from 'vitest'

import type { GraphClient, PageSummary } from '@/graph/client'
import { createOneNoteConnector, splitTitle, stampTitle } from '../onenote'

const STAMP = '2026-10-04T13:38:08.123Z'
const SECTION = { id: 'sec', displayName: '_md Test' }

function fakeGraph(pages: PageSummary[]) {
  const calls: { op: string; args: unknown[] }[] = []
  const graph = {
    pages: async () => pages,
    savePageContent: async (...args: unknown[]) => void calls.push({ op: 'save', args }),
    renamePage: async (...args: unknown[]) => void calls.push({ op: 'rename', args }),
    createPage: async (_section: unknown, title: string) => ({
      id: 'new',
      title,
      contentUrl: '',
      lastModifiedDateTime: '2026-01-01T00:00:00Z',
    }),
  } as unknown as GraphClient
  return { graph, calls }
}

const summary = (title: string): PageSummary => ({
  id: 'p1',
  title,
  contentUrl: '',
  lastModifiedDateTime: '2026-01-01T00:00:00Z',
})

describe('title version marker (S10.4)', () => {
  it('splits a stamped title', () => {
    expect(splitTitle(`#${STAMP}# Groceries`)).toEqual({ title: 'Groceries', version: STAMP })
    expect(splitTitle(`#${STAMP}#`)).toEqual({ title: '', version: STAMP })
  })

  it('leaves titles without a marker alone', () => {
    expect(splitTitle('Groceries')).toEqual({ title: 'Groceries', version: null })
    expect(splitTitle('Issue #42#')).toEqual({ title: 'Issue #42#', version: null })
    expect(splitTitle(`Notes #${STAMP}#`)).toEqual({ title: `Notes #${STAMP}#`, version: null })
  })

  it('puts the marker first so titles sort by version', () => {
    expect(stampTitle('Zebra', '2026-01-01T00:00:00.000Z') < stampTitle('Apple', STAMP)).toBe(true)
  })

  it('round-trips', () => {
    expect(splitTitle(stampTitle('Groceries', STAMP))).toEqual({
      title: 'Groceries',
      version: STAMP,
    })
    expect(splitTitle(stampTitle('', STAMP))).toEqual({ title: '', version: STAMP })
  })

  it('lists bare titles with the marker as version, else the timestamp', async () => {
    const { graph } = fakeGraph([
      summary(`#${STAMP}# Groceries`),
      { ...summary('Old page'), id: 'p2' },
    ])
    const listed = await createOneNoteConnector(graph).listPages(SECTION)
    expect(listed).toEqual([
      { id: 'p1', title: 'Groceries', version: STAMP },
      { id: 'p2', title: 'Old page', version: '2026-01-01T00:00:00Z' },
    ])
  })

  it('stamps the bare title on content writes and renames', async () => {
    const { graph, calls } = fakeGraph([])
    const connector = createOneNoteConnector(graph)
    await connector.writePage({ id: 'p1', title: 'Groceries', version: 'old' }, 'milk')
    await connector.renamePage({ id: 'p1', title: 'Groceries', version: 'old' }, 'Shopping')

    const saved = splitTitle(calls[0]!.args[2] as string)
    expect(saved.title).toBe('Groceries')
    expect(saved.version).not.toBeNull()
    expect(splitTitle(calls[1]!.args[1] as string).title).toBe('Shopping')
  })

  it('stamps new pages and returns them with a bare title', async () => {
    const { graph } = fakeGraph([])
    const page = await createOneNoteConnector(graph).createPage(SECTION, 'Groceries', 'milk')
    expect(page.title).toBe('Groceries')
    expect(page.version).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
