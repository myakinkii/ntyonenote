import type { PageSummary, Section } from '@/graph/client'
import type { MagicContent } from '@/graph/codec'
import { ONENOTE, MAIN, pagePath, type PageChange, type PendingMerge, type Repo } from './repo'

/** The bits of the Graph client sync needs */
export interface Remote {
  pages(section: Section): Promise<PageSummary[]>
  pageContent(page: PageSummary): Promise<MagicContent>
  savePageContent(page: PageSummary, markdown: string): Promise<MagicContent>
}

/** What we know about a section's pages as of the last sync */
export interface SectionMeta {
  pages: PageSummary[]
}

export interface MetaStore {
  load(sectionId: string): Promise<SectionMeta | null>
  save(sectionId: string, meta: SectionMeta): Promise<void>
}

export interface SyncResult {
  pulled: number
  pushed: number
  /** set when the merge stopped on conflicts, nothing was pushed then */
  conflict: PendingMerge | null
  pages: PageSummary[]
}

export function createSync(repo: Repo, remote: Remote, meta: MetaStore) {
  /**
   * Fetches pages OneNote changed since the last sync onto the onenote branch,
   * then merges them into main.
   */
  async function pull(section: Section): Promise<{ pulled: number; conflict: PendingMerge | null; pages: PageSummary[] }> {
    const known = new Map((await meta.load(section.id))?.pages.map((p) => [p.id, p]) ?? [])
    const remotePages = await remote.pages(section)
    const mirrored = await repo.sectionBlobs(ONENOTE, section.id)

    const changes: PageChange[] = []
    for (const page of remotePages) {
      const before = known.get(page.id)
      if (before?.lastModifiedDateTime === page.lastModifiedDateTime && mirrored.has(page.id)) continue
      const { markdown } = await remote.pageContent(page)
      changes.push({ path: pagePath(section.id, page.id), content: markdown })
    }
    const remoteIds = new Set(remotePages.map((p) => p.id))
    for (const id of mirrored.keys()) {
      if (!remoteIds.has(id)) changes.push({ path: pagePath(section.id, id), content: null })
    }

    await repo.commitToBranch(ONENOTE, changes, `Fetch ${section.displayName}: ${changes.length} page(s)`)
    await meta.save(section.id, { pages: remotePages })
    const conflict = await repo.mergeOneNote()
    return { pulled: changes.length, conflict, pages: remotePages }
  }

  /** Uploads pages that differ between main and onenote, records what OneNote stored */
  async function push(section: Section, pages: PageSummary[]): Promise<number> {
    const byId = new Map(pages.map((p) => [p.id, p]))
    const stored: PageChange[] = []
    const adjusted: string[] = []

    for (const id of await repo.unsynced(section.id)) {
      const page = byId.get(id)
      const path = pagePath(section.id, id)
      const markdown = await repo.readAt(MAIN, path)
      // pages are created and deleted online, so only existing pages can differ
      if (!page || markdown === null) continue
      const result = await remote.savePageContent(page, markdown)
      stored.push({ path, content: result.markdown })
      if (result.markdown !== markdown) {
        // codec could not round-trip it (e.g. tabs): keep OneNote's version locally too
        await repo.writePage(path, result.markdown)
        adjusted.push(path)
      }
    }

    if (adjusted.length) await repo.commitWorktree(adjusted, 'Apply OneNote adjustments')
    await repo.commitToBranch(ONENOTE, stored, `Upload ${section.displayName}: ${stored.length} page(s)`)
    // both sides now hold the same text, so this merge is always clean
    await repo.mergeOneNote()
    if (stored.length) {
      // our own uploads bumped lastModifiedDateTime, don't fetch them back next time
      await meta.save(section.id, { pages: await remote.pages(section) })
    }
    return stored.length
  }

  /** fetch + 3-way merge + upload; stops before uploading when the merge has conflicts */
  async function sync(section: Section): Promise<SyncResult> {
    if (await repo.pendingMerge()) throw new Error('Finish resolving conflicts before syncing again.')
    const { pulled, conflict, pages } = await pull(section)
    if (conflict) return { pulled, pushed: 0, conflict, pages }
    const pushed = await push(section, pages)
    const latest = (await meta.load(section.id))?.pages ?? pages
    return { pulled, pushed, conflict: null, pages: latest }
  }

  return { pull, push, sync }
}
