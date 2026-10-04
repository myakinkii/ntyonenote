import type { Connector, Notebook, RemotePage, Section } from './connector'
import { LEDGER_PATH, pagePath, parseLedger, parsePagePath, serializeLedger, type Ledger, type LedgerPage } from './ledger'
import { IMPORT, LOCAL_AUTHOR, MAIN, type FileChange, type PendingMerge, type Repo } from './repo'

// Sync engine, see docs/sync-design.md (S4-S9).

/** pages per section whose content is downloaded on sync even if never opened (S4.1.3) */
export const PREFETCH_PAGES = 20

export interface SyncResult {
  notebooks: Notebook[]
  fetched: number
  pushed: number
  /** set when the merge stopped on conflicts, nothing was pushed then */
  conflict: PendingMerge | null
  /** offline-created page ids -> the ids the remote gave them */
  created: Map<string, string>
  /** titles where a remote rename won over a local one (S4.1.3) */
  titleConflicts: string[]
}

export interface HistoryEntry {
  oid: string
  /** the page's file at that commit, its id may have been local then */
  path: string
  message: string
  date: Date
  from: 'local' | 'remote' | 'merge' | 'convert'
}

export function createSync(repo: Repo, connector: Connector) {
  const remote = connector.id

  async function readLedger(): Promise<Ledger> {
    return parseLedger(await repo.readFile(LEDGER_PATH), remote)
  }

  const ledgerChange = (ledger: Ledger): FileChange => ({ path: LEDGER_PATH, content: serializeLedger(ledger) })
  const commitLedger = (ledger: Ledger, message: string, by = remote) =>
    repo.commitFiles([ledgerChange(ledger)], message, by)

  const asRemote = (id: string, entry: LedgerPage): RemotePage => ({
    id,
    title: entry.remoteTitle ?? entry.title,
    version: entry.modified ?? '',
  })

  const sectionOf = (ledger: Ledger, id: string): Section => ({ id, displayName: ledger.sections[id]?.name ?? '' })

  async function ensureNoMerge() {
    if (await repo.pendingMerge()) throw new Error('Finish resolving conflicts first.')
  }

  // --- S4.1 fetch ---

  async function fetchAll(ledger: Ledger, notebooks: Notebook[]) {
    const mirrored = await repo.files(remote)
    const changes: FileChange[] = []
    const titleConflicts: string[] = []

    const listedSections = new Set<string>()
    for (const notebook of notebooks) {
      for (const section of notebook.sections.filter((s) => connector.isSyncable(s))) {
        // keep what else the entry holds (a convert source, C3), only `deleted` goes when it's back
        const { deleted: _deleted, ...kept } = ledger.sections[section.id] ?? {}
        ledger.sections[section.id] = { ...kept, name: section.displayName, notebook: notebook.displayName }
        listedSections.add(section.id)
      }
    }
    for (const [id, section] of Object.entries(ledger.sections)) {
      if (!listedSections.has(id)) section.deleted = true
    }

    for (const sectionId of listedSections) {
      const listed = await connector.listPages(sectionOf(ledger, sectionId))

      for (const [index, page] of listed.entries()) {
        const entry = (ledger.pages[page.id] ??= {
          section: sectionId,
          title: page.title,
          remote: true,
          remoteTitle: page.title,
        })
        entry.remote = true
        if (entry.remoteTitle !== page.title) {
          // renamed remotely: OneNote wins, a local rename since the last sync is reported
          if (entry.title !== entry.remoteTitle) titleConflicts.push(page.title)
          entry.title = entry.remoteTitle = page.title
        }
        entry.modified = page.version

        const path = pagePath(sectionId, page.id)
        const wanted = mirrored.has(path) ? entry.fetched !== page.version : index < PREFETCH_PAGES
        if (wanted) {
          changes.push({ path, content: await connector.readPage(page) })
          entry.fetched = page.version
        }
      }

      // missing from the listing: gone only if the remote confirms it (S4.1.4)
      const listedIds = new Set(listed.map((p) => p.id))
      for (const [id, entry] of Object.entries(ledger.pages)) {
        if (entry.section !== sectionId || !entry.remote || listedIds.has(id)) continue
        if (await connector.pageExists(id)) continue
        if (entry.deleted) {
          delete ledger.pages[id]
        } else {
          entry.remote = false
          delete entry.remoteTitle
          delete entry.modified
          delete entry.fetched
        }
        const path = pagePath(sectionId, id)
        if (mirrored.has(path)) changes.push({ path, content: null })
      }
    }

    await repo.commitToBranch(remote, changes, `Fetch ${changes.length} page(s)`, remote)
    return { fetched: changes.length, titleConflicts }
  }

  /** Drops entries of pages gone remotely whose local file is gone too (S8.3) */
  async function prune(ledger: Ledger) {
    for (const [id, entry] of Object.entries(ledger.pages)) {
      if (entry.remote || entry.deleted) continue
      if ((await repo.readFile(pagePath(entry.section, id))) === null) delete ledger.pages[id]
    }
  }

  // --- S4.3 push ---

  async function pushAll(ledger: Ledger) {
    const created = new Map<string, string>()
    const sent: FileChange[] = []
    const pushed = new Set<string>()
    const mirrored = await repo.files(remote)

    for (const [id, entry] of Object.entries(ledger.pages)) {
      if (ledger.sections[entry.section]?.deleted) continue
      const section = sectionOf(ledger, entry.section)
      const path = pagePath(entry.section, id)

      if (entry.deleted) {
        if (entry.remote) await connector.deletePage(asRemote(id, entry))
        delete ledger.pages[id]
        if (mirrored.has(path)) sent.push({ path, content: null })
        pushed.add(id)
        continue
      }

      let md = await repo.readAt(MAIN, path)
      if (md !== null && connector.normalize(md) !== md) {
        md = connector.normalize(md)
        await repo.commitFiles([{ path, content: md }], `Normalize ${entry.title}`, remote)
      }

      if (!entry.remote) {
        if (md === null) continue
        const page = await connector.createPage(section, entry.title, md)
        const realPath = pagePath(entry.section, page.id)
        delete ledger.pages[id]
        ledger.pages[page.id] = {
          section: entry.section,
          title: entry.title,
          remote: true,
          remoteTitle: page.title,
          modified: page.version,
          createdAs: id,
        }
        // commit right away so a crash can't create the page twice (S4.3.1)
        await repo.commitFiles(
          [{ path, content: null }, { path: realPath, content: md }, ledgerChange(ledger)],
          `Upload ${entry.title}`,
          remote,
        )
        await repo.commitToBranch(remote, [{ path: realPath, content: md }], `Upload ${entry.title}`, remote)
        created.set(id, page.id)
        pushed.add(page.id)
        continue
      }

      if (md !== null && mirrored.has(path) && !(await repo.sameAt(MAIN, remote, path))) {
        await connector.writePage(asRemote(id, entry), md)
        sent.push({ path, content: md })
        pushed.add(id)
      }
      if (entry.title !== entry.remoteTitle) {
        await connector.renamePage(asRemote(id, entry), entry.title)
        entry.remoteTitle = entry.title
        pushed.add(id)
      }
    }

    await repo.commitToBranch(remote, sent, `Push ${sent.length} page(s)`, remote)
    return { pushed: pushed.size, created }
  }

  // --- public ---

  /** One-time move from the earlier layout with `<pageId>.title` files to the ledger */
  async function migrate() {
    if ((await repo.readFile(LEDGER_PATH)) !== null || (await repo.pendingMerge())) return
    const titles = [...(await repo.files(MAIN))].filter((path) => path.endsWith('.title'))
    if (!titles.length) return

    const ledger = await readLedger()
    for (const path of await repo.files(MAIN)) {
      if (!path.endsWith('.md')) continue
      const { sectionId, pageId } = parsePagePath(path)
      const titlePath = path.replace(/\.md$/, '.title')
      const remoteTitle = await repo.readAt(remote, titlePath)
      ledger.pages[pageId] = {
        section: sectionId,
        title: (await repo.readAt(MAIN, titlePath)) ?? '',
        remote: !pageId.startsWith('local-'),
        ...(remoteTitle !== null && { remoteTitle }),
      }
    }
    const removed = (paths: Iterable<string>) => [...paths].filter((p) => p.endsWith('.title')).map((path) => ({ path, content: null }))
    await repo.commitToBranch(remote, removed(await repo.files(remote)), 'Move titles to the ledger', remote)
    await repo.commitFiles([...removed(titles), ledgerChange(ledger)], 'Move titles to the ledger', LOCAL_AUTHOR)
    await repo.merge(remote)
  }

  /** S4: fetch + merge + push + merge. Stops before pushing when the merge has conflicts. */
  async function sync(): Promise<SyncResult> {
    await ensureNoMerge()
    const notebooks = await connector.notebooks()
    const ledger = await readLedger()

    const { fetched, titleConflicts } = await fetchAll(ledger, notebooks)
    ledger.lastSync = new Date().toISOString()
    await commitLedger(ledger, 'Fetch')

    const conflict = await repo.merge(remote)
    if (conflict) return { notebooks, fetched, pushed: 0, conflict, created: new Map(), titleConflicts }

    await prune(ledger)
    const { pushed, created } = await pushAll(ledger)
    await commitLedger(ledger, 'Push')
    // S4.4: what we pushed becomes the new merge base
    await repo.merge(remote)
    return { notebooks, fetched, pushed, conflict: null, created, titleConflicts }
  }

  /** After conflicts are resolved: commit the merge and tidy the ledger; the next sync pushes */
  async function completeMerge(pending: PendingMerge) {
    await repo.completeMerge(pending, remote)
    const ledger = await readLedger()
    await prune(ledger)
    await commitLedger(ledger, 'Merge cleanup')
  }

  /** S6: downloads a page that was never fetched, online only */
  async function fetchPage(pageId: string) {
    await ensureNoMerge()
    const ledger = await readLedger()
    const entry = ledger.pages[pageId]
    if (!entry?.remote) return
    const content = await connector.readPage(asRemote(pageId, entry))
    await repo.commitToBranch(remote, [{ path: pagePath(entry.section, pageId), content }], `Fetch ${entry.title}`, remote)
    entry.fetched = entry.modified
    await commitLedger(ledger, `Fetch ${entry.title}`)
    await repo.merge(remote)
  }

  /** S7: removes the local copy of a section deleted remotely */
  async function removeSection(sectionId: string) {
    await ensureNoMerge()
    const ledger = await readLedger()
    const files: FileChange[] = []
    for (const [id, entry] of Object.entries(ledger.pages)) {
      if (entry.section !== sectionId) continue
      files.push({ path: pagePath(sectionId, id), content: null })
      delete ledger.pages[id]
    }
    delete ledger.sections[sectionId]
    const mirrored = await repo.files(remote)
    await repo.commitToBranch(
      remote,
      files.filter((f) => mirrored.has(f.path)),
      'Remove deleted section',
      remote,
    )
    await repo.commitFiles([...files, ledgerChange(ledger)], 'Remove deleted section', LOCAL_AUTHOR)
    await repo.merge(remote)
  }

  /** S9: main's first-parent commits that changed a page's content or title, following createdAs */
  async function history(pageId: string): Promise<HistoryEntry[]> {
    const result: HistoryEntry[] = []
    const ledgers = new Map<string, Ledger>()
    const ledgerAt = async (oid: string) => {
      if (!ledgers.has(oid)) ledgers.set(oid, parseLedger(await repo.readAtCommit(oid, LEDGER_PATH), remote))
      return ledgers.get(oid)!
    }

    let id = pageId
    let section = (await readLedger()).pages[pageId]?.section ?? ''
    for (const commit of await repo.log()) {
      const parent = commit.parents[0]
      const now = (await ledgerAt(commit.oid)).pages[id]
      section = now?.section ?? section
      const parentLedger = parent ? await ledgerAt(parent) : null
      // the upload commit renamed the page: before it, it had its local id
      const parentId = now?.createdAs && !parentLedger?.pages[id] ? now.createdAs : id
      const before = parentLedger?.pages[parentId]

      const mdNow = await repo.blobAt(commit.oid, pagePath(section, id))
      const mdBefore = parent ? await repo.blobAt(parent, pagePath(section, parentId)) : null
      const renamed = !!now && !!before && now.title !== before.title
      // the upload commit counts too: it's where the page got its remote id
      if (mdNow !== mdBefore || renamed || parentId !== id) {
        result.push({
          oid: commit.oid,
          path: pagePath(section, id),
          message: commit.message,
          date: commit.date,
          from: commit.parents.length > 1 ? 'merge' : commit.author === LOCAL_AUTHOR ? 'local' : commit.author === IMPORT ? 'convert' : 'remote',
        })
      }
      if (!before && mdBefore === null && (now || mdNow)) break
      id = parentId
    }
    return result
  }

  return { migrate, readLedger, sync, completeMerge, fetchPage, removeSection, history }
}

export type SyncEngine = ReturnType<typeof createSync>
