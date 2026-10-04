// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Connector, RemotePage, Section } from '../connector'
import { createConvert, mirrorName, type ConvertSource, type ConvertTarget } from '../convert'
import { LEDGER_PATH, pagePath, parseLedger, type Ledger } from '../ledger'
import { createRepo, IMPORT, MAIN, type Repo } from '../repo'
import { createSync } from '../sync'

const NOTEBOOK = 'nb'
const SOURCE: Section = { id: 'src', displayName: 'Recipes' }

/** OneNote with one regular section; mirrors and their pages live next to it */
function fakeOneNote() {
  let clock = 0
  let ids = 0
  const sections = new Map<string, string>([[SOURCE.id, SOURCE.displayName]])
  const pages = new Map<
    string,
    { section: string; title: string; body: string; version: number; created: string }
  >()
  const failing = new Set<string>()

  const summary = (id: string): RemotePage => ({
    id,
    title: pages.get(id)!.title,
    version: String(pages.get(id)!.version),
  })

  const connector: Connector = {
    id: 'onenote',
    notebooks: async () => [
      {
        id: NOTEBOOK,
        displayName: 'Notebook',
        sections: [...sections].map(([id, displayName]) => ({ id, displayName })),
      },
    ],
    isSyncable: (s) => s.displayName.startsWith('_md'),
    listPages: async (s) =>
      [...pages]
        .filter(([, p]) => p.section === s.id)
        .sort(([, a], [, b]) => b.version - a.version)
        .map(([id]) => summary(id)),
    pageExists: async (id) => pages.has(id),
    readPage: async (page) => pages.get(page.id)!.body,
    normalize: (md) => md,
    writePage: async (page, md) =>
      void Object.assign(pages.get(page.id)!, { body: md, version: ++clock }),
    createPage: async (s, title, md) => {
      const id = `mirror-${++ids}`
      pages.set(id, { section: s.id, title, body: md, version: ++clock, created: 'now' })
      return summary(id)
    },
    renamePage: async (page, title) =>
      void Object.assign(pages.get(page.id)!, { title, version: ++clock }),
    deletePage: async (page) => void pages.delete(page.id),
  }

  const source: ConvertSource = {
    listPages: async (sectionId) =>
      [...pages]
        .filter(([, p]) => p.section === sectionId)
        .map(([id, p]) => ({ id, title: p.title, created: p.created })),
    readHtml: async (pageId) => {
      if (failing.has(pageId)) throw Object.assign(new Error('Server busy'), { status: 503 })
      return pages.get(pageId)!.body
    },
    createSection: async (_notebook, name) => {
      const id = `sec-${++ids}`
      sections.set(id, name)
      return { id, displayName: name }
    },
    isFatal: (e) => (e as { status?: number }).status === 401,
  }

  const addSource = (id: string, body: string, created: string) =>
    pages.set(id, { section: SOURCE.id, title: id.toUpperCase(), body, version: ++clock, created })

  return {
    connector,
    source,
    pages,
    failing,
    addSource,
    edit: (id: string, body: string) => Object.assign(pages.get(id)!, { body }),
  }
}

/** the "converter": source pages hold their markdown as HTML body, WARN marks a warning */
const convert = (html: string) => ({ markdown: html, warnings: html.includes('WARN') ? 1 : 0 })

let repo: Repo
let onenote: ReturnType<typeof fakeOneNote>
const target: ConvertTarget = {
  notebookId: NOTEBOOK,
  notebookName: 'Notebook',
  section: SOURCE,
  takenNames: ['Recipes'],
}
const noSleep = async () => {}

const ledger = async (): Promise<Ledger> =>
  parseLedger(await repo.readAt(MAIN, LEDGER_PATH), 'onenote')
const engine = () => createConvert(repo, onenote.connector, onenote.source, convert)
const run = (again = false) => engine().convertSection(target, { again, sleep: noSleep })

beforeEach(async () => {
  repo = createRepo(fs, fs.mkdtempSync(path.join(os.tmpdir(), 'ntyonenote-convert-')))
  await repo.init('onenote')
  onenote = fakeOneNote()
})

describe('mirrorName (C2.1)', () => {
  it('prefixes, sanitizes, shortens and numbers', () => {
    expect(mirrorName('Recipes', [])).toBe('_md Recipes')
    expect(mirrorName('A/B: C?', [])).toBe('_md A-B- C-')
    expect(mirrorName('Recipes', ['_md recipes'])).toBe('_md Recipes (2)')
    expect(mirrorName('x'.repeat(60), [])).toHaveLength(50)
    expect(mirrorName('x'.repeat(60), ['_md ' + 'x'.repeat(46)])).toMatch(/ \(2\)$/)
  })
})

describe('convert', () => {
  it('creates a mirror with every page, oldest first, nothing left unsynced (C5)', async () => {
    onenote.addSource('newer', 'new text', '2020-01-01T00:00:00Z')
    onenote.addSource('older', 'old text WARN', '2019-01-01T00:00:00Z')

    const result = await run()
    expect(result).toMatchObject({ created: 2, withWarnings: 1, failed: [], conflict: null })
    expect(result.mirror.displayName).toBe('_md Recipes')

    const l = await ledger()
    const section = l.sections[result.mirror.id]!
    expect(section.source).toEqual({
      id: 'src',
      name: 'Recipes',
      pages: { older: 'mirror-2', newer: 'mirror-3' },
    })
    expect(l.pages['mirror-2']).toMatchObject({
      title: 'OLDER',
      created: '2019-01-01T00:00:00Z',
      remote: true,
    })

    for (const id of ['mirror-2', 'mirror-3']) {
      const file = pagePath(result.mirror.id, id)
      expect(await repo.readAt(MAIN, file)).toBe(onenote.pages.get(id)!.body)
      expect(await repo.sameAt(MAIN, 'onenote', file)).toBe(true)
      expect(await repo.sameAt(MAIN, IMPORT, file)).toBe(true)
    }
  })

  it('leaves sync nothing to do afterwards, and sync keeps the source (C3, S4.1)', async () => {
    onenote.addSource('a', 'text', '2019-01-01T00:00:00Z')
    const { mirror } = await run()
    const synced = await createSync(repo, onenote.connector).sync()
    expect(synced).toMatchObject({ fetched: 0, pushed: 0 })
    expect((await ledger()).sections[mirror.id]!.source?.pages).toEqual({ a: 'mirror-2' })
  })

  it('resumes where it stopped and records failures (C5.6-C5.8)', async () => {
    onenote.addSource('a', 'A', '2019-01-01T00:00:00Z')
    onenote.addSource('b', 'B', '2019-02-01T00:00:00Z')
    onenote.failing.add('b')
    const first = await run()
    expect(first.created).toBe(1)
    expect(first.failed).toEqual([{ title: 'B', reason: 'Server busy' }])

    onenote.failing.clear()
    const second = await run()
    expect(second).toMatchObject({ created: 1, failed: [] })
    expect(second.mirror).toEqual(first.mirror)
    expect(Object.keys((await ledger()).sections[first.mirror.id]!.source!.pages)).toEqual([
      'a',
      'b',
    ])
  })

  it('stops on a fatal error', async () => {
    onenote.addSource('a', 'A', '2019-01-01T00:00:00Z')
    onenote.source.readHtml = async () => {
      throw Object.assign(new Error('signed out'), { status: 401 })
    }
    await expect(run()).rejects.toThrow('signed out')
  })

  it('converting again with no changes commits nothing (C6.1)', async () => {
    onenote.addSource('a', 'A', '2019-01-01T00:00:00Z')
    await run()
    const before = (await repo.log()).length
    expect(await run(true)).toMatchObject({ created: 0, updated: 0, unchanged: 1, conflict: null })
    expect((await repo.log()).length).toBe(before)
  })

  it('merges source changes into local edits, conflicts on the same lines (C6.2)', async () => {
    onenote.addSource('a', 'one\ntwo\nthree\nfour\nfive', '2019-01-01T00:00:00Z')
    onenote.addSource('b', 'x', '2019-02-01T00:00:00Z')
    const { mirror } = await run()
    const fileA = pagePath(mirror.id, 'mirror-2')
    const fileB = pagePath(mirror.id, 'mirror-3')
    await repo.commitFiles(
      [{ path: fileA, content: 'one\ntwo\nthree\nfour\nfive, edited here' }],
      'Save',
    )
    await repo.commitFiles([{ path: fileB, content: 'mine' }], 'Save')

    onenote.edit('a', 'ONE\ntwo\nthree\nfour\nfive')
    onenote.edit('b', 'theirs')
    const result = await run(true)
    expect(result.updated).toBe(2)
    expect(result.conflict).toMatchObject({ conflicts: [fileB], branch: IMPORT })
    expect(await repo.readFile(fileA)).toBe('ONE\ntwo\nthree\nfour\nfive, edited here')
  })

  it("doesn't recreate pages deleted on purpose and reports gone sources (C6.3, C6.5)", async () => {
    onenote.addSource('a', 'A', '2019-01-01T00:00:00Z')
    onenote.addSource('b', 'B', '2019-02-01T00:00:00Z')
    const { mirror } = await run()

    // the user deletes the mirror of a, sync pushes that and drops its entry (S4.3.4)
    const sync = createSync(repo, onenote.connector)
    const l = await ledger()
    l.pages['mirror-2']!.deleted = true
    await repo.commitFiles(
      [
        { path: pagePath(mirror.id, 'mirror-2'), content: null },
        { path: LEDGER_PATH, content: JSON.stringify(l) },
      ],
      'Delete',
    )
    await sync.sync()
    expect((await ledger()).pages['mirror-2']).toBeUndefined()

    onenote.pages.delete('b')
    const result = await run(true)
    expect(result).toMatchObject({ created: 0, skipped: ['A'], gone: ['B'] })
  })

  it('reuses the mirror after a rename, by id (C2.3)', async () => {
    onenote.addSource('a', 'A', '2019-01-01T00:00:00Z')
    const first = await run()
    const sync = createSync(repo, onenote.connector)
    const l = await ledger()
    l.sections[first.mirror.id]!.name = '_md Cooking'
    await repo.commitFiles([{ path: LEDGER_PATH, content: JSON.stringify(l) }], 'Rename')
    await sync.sync()
    onenote.addSource('b', 'B', '2019-02-01T00:00:00Z')
    expect((await run()).mirror.id).toBe(first.mirror.id)
  })
})
