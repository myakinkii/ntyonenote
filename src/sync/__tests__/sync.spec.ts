// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { PageSummary, Section } from '@/graph/client'
import { createRepo, MAIN, ONENOTE, pagePath, type Repo } from '../repo'
import { createSync, type MetaStore, type Remote, type SectionMeta } from '../sync'

const section: Section = { id: 'sec', displayName: '_md Test', pagesUrl: '' }

/** In-memory OneNote: every save bumps lastModifiedDateTime like the real one */
function fakeOneNote(initial: Record<string, string>) {
  let clock = 0
  const pages = new Map(Object.entries(initial).map(([id, md]) => [id, { md, modified: ++clock }]))
  const summary = (id: string): PageSummary => ({
    id,
    title: id,
    contentUrl: id,
    lastModifiedDateTime: String(pages.get(id)!.modified),
  })
  const remote: Remote = {
    pages: async () => [...pages.keys()].map(summary),
    pageContent: async (page) => ({ id: 'p', markdown: pages.get(page.id)!.md }),
    savePageContent: async (page, markdown) => {
      // like the codec: tabs come back as spaces
      const stored = markdown.replace(/\t/g, '    ')
      pages.set(page.id, { md: stored, modified: ++clock })
      return { id: 'p', markdown: stored }
    },
  }
  return {
    remote,
    get: (id: string) => pages.get(id)?.md,
    edit: (id: string, md: string) => pages.set(id, { md, modified: ++clock }),
    remove: (id: string) => pages.delete(id),
  }
}

function memoryMeta(): MetaStore {
  const data = new Map<string, SectionMeta>()
  return { load: async (id) => data.get(id) ?? null, save: async (id, value) => void data.set(id, value) }
}

let repo: Repo
const file = (id: string) => pagePath(section.id, id)

async function saveLocal(id: string, md: string) {
  await repo.writePage(file(id), md)
  await repo.commitWorktree([file(id)], `Save ${id}`)
}

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntyonenote-'))
  repo = createRepo(fs, dir)
  await repo.init()
})

describe('sync', () => {
  it('fetches all pages on first sync', async () => {
    const onenote = fakeOneNote({ a: '# A', b: '# B' })
    const result = await createSync(repo, onenote.remote, memoryMeta()).sync(section)

    expect(result).toMatchObject({ pulled: 2, pushed: 0, conflict: null })
    expect(await repo.readPage(file('a'))).toBe('# A')
    expect(await repo.unsynced(section.id)).toEqual([])
  })

  it('uploads local saves and only fetches what changed', async () => {
    const onenote = fakeOneNote({ a: '# A', b: '# B' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)

    await saveLocal('a', '# A\n\nlocal line')
    expect(await repo.unsynced(section.id)).toEqual(['a'])

    expect(await sync.sync(section)).toMatchObject({ pulled: 0, pushed: 1 })
    expect(onenote.get('a')).toBe('# A\n\nlocal line')
    expect(await repo.unsynced(section.id)).toEqual([])
    // our own upload is not fetched back
    expect((await sync.sync(section)).pulled).toBe(0)
  })

  it('merges edits to different lines from both sides', async () => {
    const onenote = fakeOneNote({ a: 'one\ntwo\nthree\nfour\nfive' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)

    await saveLocal('a', 'ONE\ntwo\nthree\nfour\nfive')
    onenote.edit('a', 'one\ntwo\nthree\nfour\nFIVE')

    expect(await sync.sync(section)).toMatchObject({ pulled: 1, pushed: 1, conflict: null })
    expect(await repo.readPage(file('a'))).toBe('ONE\ntwo\nthree\nfour\nFIVE')
    expect(onenote.get('a')).toBe('ONE\ntwo\nthree\nfour\nFIVE')
  })

  it('stops on conflicts and uploads after they are resolved', async () => {
    const onenote = fakeOneNote({ a: 'hello' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)

    await saveLocal('a', 'hello from the app')
    onenote.edit('a', 'hello from OneNote')

    const result = await sync.sync(section)
    expect(result.pushed).toBe(0)
    expect(result.conflict?.conflicts).toEqual([file('a')])
    expect(await repo.readPage(file('a'))).toContain('<<<<<<<')
    expect(onenote.get('a')).toBe('hello from OneNote')
    await expect(sync.sync(section)).rejects.toThrow(/conflicts/)

    await repo.writePage(file('a'), 'hello from both')
    await repo.completeMerge(result.conflict!)
    expect(await repo.pendingMerge()).toBeNull()

    expect(await sync.sync(section)).toMatchObject({ pulled: 0, pushed: 1 })
    expect(onenote.get('a')).toBe('hello from both')
  })

  it('keeps what OneNote stored when it adjusts the text', async () => {
    const onenote = fakeOneNote({ a: 'x' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)

    await saveLocal('a', '\tindented')
    await sync.sync(section)

    expect(await repo.readPage(file('a'))).toBe('    indented')
    expect(await repo.readAt(MAIN, file('a'))).toBe('    indented')
    expect(await repo.readAt(ONENOTE, file('a'))).toBe('    indented')
  })

  it('removes pages deleted in OneNote', async () => {
    const onenote = fakeOneNote({ a: '# A', b: '# B' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)

    onenote.remove('b')
    const result = await sync.sync(section)

    expect(result.pages.map((p) => p.id)).toEqual(['a'])
    expect(await repo.readPage(file('b'))).toBeNull()
  })

  it('keeps page history on main', async () => {
    const onenote = fakeOneNote({ a: 'v1' })
    const sync = createSync(repo, onenote.remote, memoryMeta())
    await sync.sync(section)
    await saveLocal('a', 'v2')
    await saveLocal('a', 'v3')

    const history = await repo.history(file('a'))
    expect(history.map((c) => c.message)).toEqual(['Save a', 'Save a', 'Fetch _md Test: 1 page(s)'])
    expect(await repo.readAtCommit(history[1]!.oid, file('a'))).toBe('v2')
  })
})
