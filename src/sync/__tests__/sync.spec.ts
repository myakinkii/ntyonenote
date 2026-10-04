// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Connector, RemotePage } from '../connector'
import { LEDGER_PATH, newLocalId, pagePath, parseLedger, serializeLedger, type Ledger } from '../ledger'
import { createRepo, MAIN, type Repo } from '../repo'
import { createSync, PREFETCH_PAGES, type SyncEngine } from '../sync'

const SEC = 'sec'

/** In-memory OneNote: every change bumps the page version like lastModifiedDateTime */
function fakeOneNote(initial: Record<string, string> = {}) {
  let clock = 0
  let ids = 0
  const sections = new Map([[SEC, '_md Test']])
  const pages = new Map<string, { section: string; title: string; md: string; version: number }>()
  /** listed nowhere but still there, like a lagging listing */
  const unlisted = new Set<string>()
  const add = (id: string, md: string, section = SEC) =>
    pages.set(id, { section, title: id.toUpperCase(), md, version: ++clock })
  for (const [id, md] of Object.entries(initial)) add(id, md)
  const summary = (id: string): RemotePage => ({
    id,
    title: pages.get(id)!.title,
    version: String(pages.get(id)!.version).padStart(6, '0'),
  })

  const connector: Connector = {
    id: 'onenote',
    notebooks: async () => [
      { id: 'nb', displayName: 'Notebook', sections: [...sections].map(([id, displayName]) => ({ id, displayName })) },
    ],
    isSyncable: () => true,
    listPages: async (s) =>
      [...pages]
        .filter(([id, p]) => p.section === s.id && !unlisted.has(id))
        .sort(([, a], [, b]) => b.version - a.version)
        .map(([id]) => summary(id)),
    pageExists: async (id) => pages.has(id),
    readPage: async (page) => pages.get(page.id)!.md,
    normalize: (md) => md.replace(/\t/g, '    '),
    writePage: async (page, md) => void Object.assign(pages.get(page.id)!, { md, version: ++clock }),
    createPage: async (s, title, md) => {
      const id = `remote-${++ids}`
      pages.set(id, { section: s.id, title, md, version: ++clock })
      return summary(id)
    },
    renamePage: async (page, title) => void Object.assign(pages.get(page.id)!, { title, version: ++clock }),
    deletePage: async (page) => void pages.delete(page.id),
  }
  return {
    connector,
    page: (id: string) => pages.get(id),
    ids: () => [...pages.keys()],
    add,
    edit: (id: string, md: string) => Object.assign(pages.get(id)!, { md, version: ++clock }),
    rename: (id: string, title: string) => Object.assign(pages.get(id)!, { title, version: ++clock }),
    remove: (id: string) => pages.delete(id),
    unlisted,
    removeSection: (id: string) => sections.delete(id),
  }
}

let repo: Repo
let onenote: ReturnType<typeof fakeOneNote>
let engine: SyncEngine
const md = (id: string) => pagePath(SEC, id)

async function start(initial: Record<string, string> = {}) {
  onenote = fakeOneNote(initial)
  engine = createSync(repo, onenote.connector)
  return engine.sync()
}

const ledger = async (): Promise<Ledger> => parseLedger(await repo.readAt(MAIN, LEDGER_PATH), 'onenote')
const save = (id: string, text: string) => repo.commitFiles([{ path: md(id), content: text }], `Save ${id}`)
async function editLedger(change: (l: Ledger) => void, message: string, files: { path: string; content: string | null }[] = []) {
  const l = await ledger()
  change(l)
  await repo.commitFiles([...files, { path: LEDGER_PATH, content: serializeLedger(l) }], message)
}

beforeEach(async () => {
  repo = createRepo(fs, fs.mkdtempSync(path.join(os.tmpdir(), 'ntyonenote-')))
  await repo.init('onenote')
})

describe('sync', () => {
  it('first sync creates the ledger on main only (S2.1, S3)', async () => {
    const result = await start({ a: '# A' })

    expect(result).toMatchObject({ fetched: 1, pushed: 0, conflict: null })
    expect(await repo.readFile(md('a'))).toBe('# A')
    expect((await ledger()).pages.a).toMatchObject({ section: SEC, title: 'A', remote: true, remoteTitle: 'A' })
    expect((await ledger()).sections[SEC]).toEqual({ name: '_md Test', notebook: 'Notebook' })
    expect(await repo.readAt('onenote', LEDGER_PATH)).toBeNull()
  })

  it('pushes saves; the next fetch finds its own upload identical (S4.1.6, S4.4)', async () => {
    await start({ a: '# A' })
    await save('a', '# A\n\nlocal')

    expect((await engine.sync()).pushed).toBe(1)
    expect(onenote.page('a')?.md).toBe('# A\n\nlocal')
    const again = await engine.sync()
    expect(again).toMatchObject({ fetched: 1, pushed: 0, conflict: null })
    expect(await repo.readFile(md('a'))).toBe('# A\n\nlocal')
    expect((await engine.sync()).fetched).toBe(0)
  })

  it('merges edits to different lines from both sides (S4.2)', async () => {
    await start({ a: 'one\ntwo\nthree\nfour\nfive' })
    await save('a', 'ONE\ntwo\nthree\nfour\nfive')
    onenote.edit('a', 'one\ntwo\nthree\nfour\nFIVE')

    expect(await engine.sync()).toMatchObject({ fetched: 1, pushed: 1, conflict: null })
    expect(await repo.readFile(md('a'))).toBe('ONE\ntwo\nthree\nfour\nFIVE')
    expect(onenote.page('a')?.md).toBe('ONE\ntwo\nthree\nfour\nFIVE')
  })

  it('stops on conflicts and pushes once they are resolved (S8)', async () => {
    await start({ a: 'hello' })
    await save('a', 'hello from the app')
    onenote.edit('a', 'hello from OneNote')

    const result = await engine.sync()
    expect(result).toMatchObject({ pushed: 0, conflict: { conflicts: [md('a')] } })
    expect(await repo.readFile(md('a'))).toContain('<<<<<<<')
    await expect(engine.sync()).rejects.toThrow(/conflicts/)

    await repo.writeFile(md('a'), 'hello from both')
    await engine.completeMerge(result.conflict!)
    expect((await engine.sync()).pushed).toBe(1)
    expect(onenote.page('a')?.md).toBe('hello from both')
  })

  it('normalizes text before pushing it (S4.3.2)', async () => {
    await start({ a: 'x' })
    await save('a', '\tindented')
    await engine.sync()

    expect(onenote.page('a')?.md).toBe('    indented')
    expect(await repo.readFile(md('a'))).toBe('    indented')
    expect((await engine.sync()).conflict).toBeNull()
  })

  it('deletes pages only when the remote confirms they are gone (S4.1.4)', async () => {
    await start({ a: '# A', b: '# B' })
    onenote.unlisted.add('a')
    onenote.remove('b')
    await engine.sync()

    expect(await repo.readFile(md('a'))).toBe('# A')
    expect(await repo.readFile(md('b'))).toBeNull()
    expect((await ledger()).pages.b).toBeUndefined()
  })

  it('keeps a page deleted remotely but edited locally as a new page (S8.3)', async () => {
    await start({ a: 'text' })
    await save('a', 'edited')
    onenote.remove('a')

    const result = await engine.sync()
    expect(result.conflict?.conflicts).toEqual([md('a')])
    await repo.writeFile(md('a'), 'edited')
    await engine.completeMerge(result.conflict!)

    const pushed = await engine.sync()
    const id = pushed.created.get('a')!
    expect(onenote.page(id)?.md).toBe('edited')
  })

  it('uploads offline pages under their new id and keeps their history (S4.3.1, S9.2)', async () => {
    await start()
    const local = newLocalId()
    await editLedger((l) => (l.pages[local] = { section: SEC, title: 'Offline', remote: false }), 'Create Offline', [
      { path: md(local), content: '# Offline' },
    ])
    await save(local, '# Offline\n\ntext')

    const result = await engine.sync()
    const id = result.created.get(local)!
    expect(onenote.page(id)).toMatchObject({ title: 'Offline', md: '# Offline\n\ntext' })
    expect(await repo.readFile(md(local))).toBeNull()
    expect((await ledger()).pages[id]).toMatchObject({ remote: true, createdAs: local })

    const history = await engine.history(id)
    expect(history.map((h) => h.message)).toEqual(['Upload Offline', `Save ${local}`, 'Create Offline'])
    expect(await repo.readAtCommit(history[1]!.oid, history[1]!.path)).toBe('# Offline\n\ntext')
  })

  it('pushes renames and deletes (S5.3, S5.4)', async () => {
    await start({ a: '# A', b: '# B' })
    await editLedger((l) => (l.pages.a!.title = 'Renamed'), 'Rename')
    await editLedger((l) => (l.pages.b!.deleted = true), 'Delete', [{ path: md('b'), content: null }])

    expect((await engine.sync()).pushed).toBe(2)
    expect(onenote.page('a')?.title).toBe('Renamed')
    expect(onenote.ids()).toEqual(['a'])
    expect((await ledger()).pages.b).toBeUndefined()
  })

  it('lets OneNote win when both sides renamed a page (S4.1.3)', async () => {
    await start({ a: '# A' })
    await editLedger((l) => (l.pages.a!.title = 'Mine'), 'Rename')
    onenote.rename('a', 'Theirs')

    const result = await engine.sync()
    expect(result.titleConflicts).toEqual(['Theirs'])
    expect((await ledger()).pages.a?.title).toBe('Theirs')
    expect(onenote.page('a')?.title).toBe('Theirs')
  })

  it('prefetches the most recent pages and downloads others on open (S4.1.3, S6)', async () => {
    const pages = Object.fromEntries(Array.from({ length: PREFETCH_PAGES + 3 }, (_, i) => [`p${i}`, `# ${i}`]))
    await start(pages)

    const l = await ledger()
    expect(Object.keys(l.pages)).toHaveLength(PREFETCH_PAGES + 3)
    // oldest pages stay lazy
    expect(await repo.readFile(md('p0'))).toBeNull()
    expect(await repo.readFile(md(`p${PREFETCH_PAGES + 2}`))).toBe(`# ${PREFETCH_PAGES + 2}`)

    await engine.fetchPage('p0')
    expect(await repo.readFile(md('p0'))).toBe('# 0')
    // a downloaded page is kept up to date from now on
    onenote.edit('p0', '# 0 changed')
    await engine.sync()
    expect(await repo.readFile(md('p0'))).toBe('# 0 changed')
  })

  it('keeps sections deleted remotely until removed locally (S7)', async () => {
    await start({ a: '# A' })
    onenote.removeSection(SEC)
    await engine.sync()

    expect((await ledger()).sections[SEC]?.deleted).toBe(true)
    expect(await repo.readFile(md('a'))).toBe('# A')

    await engine.removeSection(SEC)
    expect(await repo.readFile(md('a'))).toBeNull()
    expect(await ledger()).toMatchObject({ sections: {}, pages: {} })
  })

  it('shows where history entries came from (S9.3)', async () => {
    await start({ a: 'one\ntwo\nthree' })
    await save('a', 'ONE\ntwo\nthree')
    onenote.edit('a', 'one\ntwo\nTHREE')
    expect((await engine.sync()).conflict).toBeNull()

    const history = await engine.history('a')
    expect(history.map((h) => [h.message, h.from])).toEqual([
      ['Merge onenote', 'merge'],
      ['Save a', 'local'],
      ['Merge onenote', 'merge'],
    ])
  })

  it('moves the earlier .title layout into the ledger', async () => {
    onenote = fakeOneNote()
    engine = createSync(repo, onenote.connector)
    const old = [
      { path: `${SEC}/a.md`, content: '# A' },
      { path: `${SEC}/a.title`, content: 'Title A' },
    ]
    await repo.commitToBranch('onenote', old, 'old fetch', 'onenote')
    await repo.merge('onenote')

    await engine.migrate()
    expect((await ledger()).pages.a).toMatchObject({ title: 'Title A', remote: true, remoteTitle: 'Title A' })
    expect(await repo.readFile(`${SEC}/a.title`)).toBeNull()
    expect(await repo.readAt('onenote', `${SEC}/a.title`)).toBeNull()
  })
})
