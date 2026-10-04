import type { Connector, Section } from './connector'
import { LEDGER_PATH, pagePath, parseLedger, serializeLedger, type Ledger } from './ledger'
import { IMPORT, type PendingMerge, type Repo } from './repo'

// Converting a regular section into an _md mirror, see docs/convert-design.md (C2-C6).

export interface SourcePage {
  id: string
  title: string
  /** createdDateTime, the one OneNote timestamp that works (C3.2) */
  created: string
}

/** Reading regular sections and creating mirrors; OneNote's lives in connectors/onenote.ts */
export interface ConvertSource {
  listPages(sectionId: string): Promise<SourcePage[]>
  readHtml(pageId: string): Promise<string>
  createSection(notebookId: string, name: string): Promise<Section>
  /** errors that stop the whole run (signed out, offline), others only fail one page */
  isFatal(error: unknown): boolean
}

/** page HTML -> what gets committed and uploaded, plus how many warnings it has (C7, C8) */
export type PageConverter = (html: string) => { markdown: string; warnings: number }

export interface ConvertTarget {
  notebookId: string
  notebookName: string
  section: Section
  /** section names already used in that notebook, for naming a new mirror (C2.1) */
  takenNames: string[]
}

export interface ConvertOptions {
  /** C6: read and convert mapped pages again; otherwise only pages not converted yet (C5.2) */
  again?: boolean
  signal?: AbortSignal
  onProgress?: (done: number, total: number, title: string) => void
  /** for tests */
  sleep?: (ms: number) => Promise<void>
}

export interface ConvertResult {
  mirror: Section
  created: number
  updated: number
  unchanged: number
  withWarnings: number
  failed: { title: string; reason: string }[]
  /** mirror pages deleted on purpose, not recreated (C6.3) */
  skipped: string[]
  /** source pages that are gone, their mirror pages stay (C6.5) */
  gone: string[]
  conflict: PendingMerge | null
  cancelled: boolean
}

/** OneNote's limit for section names */
export const MAX_SECTION_NAME = 50
const INVALID_NAME_CHARS = /[\\/*?"|<>:%#&]/g

/** `_md <source>`, sanitized, shortened, with (2), (3), ... when taken (C2.1) */
export function mirrorName(source: string, taken: string[]): string {
  const base = `_md ${source}`.replace(INVALID_NAME_CHARS, '-')
  const used = new Set(taken.map((name) => name.toLowerCase()))
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${n})`
    const name = base.slice(0, MAX_SECTION_NAME - suffix.length).trimEnd() + suffix
    if (!used.has(name.toLowerCase())) return name
  }
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function createConvert(
  repo: Repo,
  connector: Connector,
  source: ConvertSource,
  convert: PageConverter,
) {
  const remote = connector.id

  const readLedger = async (): Promise<Ledger> =>
    parseLedger(await repo.readFile(LEDGER_PATH), remote)
  const ledgerChange = (ledger: Ledger) => ({ path: LEDGER_PATH, content: serializeLedger(ledger) })

  /** the mirror of a regular section on this device, if it was converted here (C2.3, C3.3) */
  function mirrorOf(ledger: Ledger, sectionId: string): Section | null {
    for (const [id, section] of Object.entries(ledger.sections)) {
      if (section.source?.id === sectionId && !section.deleted)
        return { id, displayName: section.name }
    }
    return null
  }

  /** C5.6: waits out 429s, retries 5xx of requests that are safe to repeat */
  async function withRetry<T>(
    task: () => Promise<T>,
    sleep: (ms: number) => Promise<void>,
    repeatable: boolean,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await task()
      } catch (e) {
        const { status, retryAfter } = (e ?? {}) as { status?: number; retryAfter?: number }
        if (status === 429 && attempt < 5) await sleep((retryAfter ?? 2 ** attempt) * 1000)
        else if (repeatable && status !== undefined && status >= 500 && attempt < 3)
          await sleep(2 ** attempt * 1000)
        else throw e
      }
    }
  }

  async function convertSection(
    target: ConvertTarget,
    options: ConvertOptions = {},
  ): Promise<ConvertResult> {
    const sleep = options.sleep ?? realSleep
    if (await repo.pendingMerge()) throw new Error('Finish resolving conflicts first.')
    await repo.init(IMPORT)

    const ledger = await readLedger()
    let mirror = mirrorOf(ledger, target.section.id)
    if (!mirror) {
      const name = mirrorName(target.section.displayName, target.takenNames)
      mirror = await withRetry(() => source.createSection(target.notebookId, name), sleep, false)
      ledger.sections[mirror.id] = {
        name: mirror.displayName,
        notebook: target.notebookName,
        source: { id: target.section.id, name: target.section.displayName, pages: {} },
      }
      await repo.commitFiles(
        [ledgerChange(ledger)],
        `Convert ${target.section.displayName}`,
        IMPORT,
      )
    }
    const mapping = ledger.sections[mirror.id]!.source!.pages

    const result: ConvertResult = {
      mirror,
      created: 0,
      updated: 0,
      unchanged: 0,
      withWarnings: 0,
      failed: [],
      skipped: [],
      gone: [],
      conflict: null,
      cancelled: false,
    }

    // oldest first, so the mirror fills up in the original order (C5.1)
    const listed = (await withRetry(() => source.listPages(target.section.id), sleep, true)).sort(
      (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id),
    )

    for (const [index, page] of listed.entries()) {
      if (options.signal?.aborted) {
        result.cancelled = true
        break
      }
      const mapped = mapping[page.id]
      if (mapped && !options.again) continue
      if (mapped && (!ledger.pages[mapped] || ledger.pages[mapped].deleted)) {
        result.skipped.push(page.title)
        continue
      }
      options.onProgress?.(index + 1, listed.length, page.title)

      try {
        const html = await withRetry(() => source.readHtml(page.id), sleep, true)
        const converted = convert(html)
        const md = connector.normalize(converted.markdown)
        if (converted.warnings) result.withWarnings++

        if (mapped) {
          // C6.1: only what changed lands on import, merged into main after the run
          const changed = await repo.commitToBranch(
            IMPORT,
            [{ path: pagePath(mirror.id, mapped), content: md }],
            `Convert ${page.title}`,
            IMPORT,
          )
          if (changed) result.updated++
          else result.unchanged++
          continue
        }

        // C5.5: a create isn't repeated on 5xx, it may have gone through
        const created = await withRetry(
          () => connector.createPage(mirror, page.title, md),
          sleep,
          false,
        )
        const path = pagePath(mirror.id, created.id)
        mapping[page.id] = created.id
        ledger.pages[created.id] = {
          section: mirror.id,
          title: page.title,
          remote: true,
          remoteTitle: created.title,
          // our version marker is unique (S10.4), so the next fetch can skip what we just sent
          modified: created.version,
          fetched: created.version,
          created: page.created,
        }
        // commit right away on all three branches, so the page is never created twice (C5.5)
        await repo.commitToBranch(IMPORT, [{ path, content: md }], `Convert ${page.title}`, IMPORT)
        await repo.commitToBranch(remote, [{ path, content: md }], `Convert ${page.title}`, IMPORT)
        await repo.commitFiles(
          [{ path, content: md }, ledgerChange(ledger)],
          `Convert ${page.title}`,
          IMPORT,
        )
        result.created++
      } catch (e) {
        if (source.isFatal(e)) throw e
        result.failed.push({
          title: page.title,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }

    if (!result.cancelled) {
      const listedIds = new Set(listed.map((p) => p.id))
      for (const [sourceId, mirrorId] of Object.entries(mapping)) {
        if (!listedIds.has(sourceId)) result.gone.push(ledger.pages[mirrorId]?.title ?? mirrorId)
      }
    }

    // import has to become an ancestor of main to be the merge base next time (C4.2): for new
    // pages it's the same content, so that merge is clean; updated pages merge for real (C6.2)
    if (result.created || result.updated) result.conflict = await repo.merge(IMPORT)
    return result
  }

  return {
    convertSection,
    mirrorOf: async (sectionId: string) => mirrorOf(await readLedger(), sectionId),
  }
}

export type ConvertEngine = ReturnType<typeof createConvert>
