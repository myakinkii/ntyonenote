import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { createOneNoteConnector, createOneNoteSource } from '@/connectors/onenote'
import { convertedMarkdown, convertPage } from '@/convert/converter'
import { GraphError } from '@/graph/client'
import type { Notebook, Section } from '@/sync/connector'
import {
  emptyLedger,
  LEDGER_PATH,
  newLocalId,
  pagePath,
  parsePagePath,
  serializeLedger,
  type Ledger,
} from '@/sync/ledger'
import { MAIN, type FileChange, type PendingMerge } from '@/sync/repo'
import { notebooksCache, repo } from '@/sync/storage'
import { createConvert, mirrorName, type ConvertResult } from '@/sync/convert'
import { createSync, type HistoryEntry } from '@/sync/sync'
import { useAuthStore } from './auth'
import { useDialogStore } from './dialog'

export type EditorTab = 'edit' | 'preview' | 'history' | 'conflicts'

export interface NotePage {
  id: string
  title: string
  /** content is local; otherwise it's downloaded on open (docs/sync-design.md S6) */
  downloaded: boolean
  /** remote lastModified as of the last sync, absent for pages created offline */
  modified?: string
}

// Local first (S1.1): everything reads and writes the local repo, only sync and lazy downloads go online.
export const useNotesStore = defineStore('notes', () => {
  const auth = useAuthStore()
  const dialog = useDialogStore()
  const connector = createOneNoteConnector(auth.graph)
  const engine = createSync(repo, connector)
  const converter = createConvert(repo, connector, createOneNoteSource(auth.graph), (html) => {
    const conversion = convertPage(html)
    return { markdown: convertedMarkdown(conversion), warnings: conversion.warnings.length }
  })

  const notebooks = ref<Notebook[]>([])
  const ledger = ref<Ledger>(emptyLedger(connector.id))
  const section = ref<Section | null>(null)
  const page = ref<NotePage | null>(null)
  const tab = ref<EditorTab>('edit')

  const markdown = ref('')
  const savedMarkdown = ref('')

  /** paths of downloaded pages on main */
  const downloaded = ref(new Set<string>())
  /** page ids in the current section with changes not pushed yet (S3.4) */
  const unsynced = ref<string[]>([])
  const merge = ref<PendingMerge | null>(null)

  /** set while a section is being converted, aborting it stops after the current page */
  const converting = ref<AbortController | null>(null)
  /** pages done of all pages while converting, for the progress bar */
  const progress = ref<{ done: number; total: number } | null>(null)

  const busy = ref(0)
  const status = ref('Ready')

  const dirty = computed(() => page.value !== null && markdown.value !== savedMarkdown.value)
  const conflicted = computed(() => new Set(merge.value?.conflicts.map((path) => parsePagePath(path).pageId) ?? []))
  const lastSync = computed(() => ledger.value.lastSync ?? null)
  const isSyncable = (s: Section) => connector.isSyncable(s)
  const sectionDeleted = computed(() => !!section.value && !!ledger.value.sections[section.value.id]?.deleted)

  /** the notebook tree plus sections deleted remotely but still kept locally (S7) */
  const tree = computed<Notebook[]>(() => {
    const deleted = Object.entries(ledger.value.sections)
      .filter(([, s]) => s.deleted)
      .map(([id, s]) => ({ id, displayName: s.name }))
    const listed = notebooks.value.map((n) => ({ ...n, sections: n.sections.filter((s) => !ledger.value.sections[s.id]?.deleted) }))
    return deleted.length ? [...listed, { id: 'deleted', displayName: 'Deleted in OneNote', sections: deleted }] : listed
  })

  /** pages of the current section, the ones created offline first, then newest */
  const pages = computed<NotePage[]>(() => {
    const current = section.value
    if (!current) return []
    return Object.entries(ledger.value.pages)
      .filter(([, p]) => p.section === current.id && !p.deleted)
      .map(([id, p]) => ({
        id,
        title: p.title,
        downloaded: downloaded.value.has(pagePath(current.id, id)),
        modified: p.modified,
      }))
      .sort((a, b) => (b.modified ?? '￿').localeCompare(a.modified ?? '￿'))
  })

  async function run<T>(message: string, task: () => Promise<T>): Promise<T | undefined> {
    busy.value++
    status.value = message
    try {
      const result = await task()
      status.value = 'Ready'
      return result
    } catch (e) {
      status.value = 'Error'
      if (e instanceof GraphError && e.status === 401) auth.tokenRejected()
      else await dialog.error('ntyonenote', e instanceof Error ? e.message : String(e))
    } finally {
      busy.value--
    }
  }

  const currentPath = () => (section.value && page.value ? pagePath(section.value.id, page.value.id) : null)

  async function refresh() {
    ledger.value = await engine.readLedger()
    merge.value = await repo.pendingMerge()
    downloaded.value = new Set((await repo.files(MAIN)))
    const current = section.value
    if (!current) {
      unsynced.value = []
      return
    }
    const changed: string[] = []
    for (const [id, p] of Object.entries(ledger.value.pages)) {
      if (p.section !== current.id) continue
      const path = pagePath(current.id, id)
      const contentChanged = downloaded.value.has(path) && !(await repo.sameAt(MAIN, connector.id, path))
      if (!p.remote || p.deleted || p.title !== p.remoteTitle || contentChanged) changed.push(id)
    }
    unsynced.value = changed
  }

  /** Re-reads the open page from disk unless the user has unsaved edits */
  async function reloadPage() {
    const path = currentPath()
    if (!path || dirty.value) return
    markdown.value = savedMarkdown.value = (await repo.readFile(path)) ?? ''
  }

  /** Commits a ledger change, optionally with page files, on main */
  async function commitLedger(change: (l: Ledger) => void, message: string, files: FileChange[] = []) {
    const next = await engine.readLedger()
    change(next)
    await repo.commitFiles([...files, { path: LEDGER_PATH, content: serializeLedger(next) }], message)
  }

  async function init() {
    await repo.init(connector.id)
    await engine.migrate()
    notebooks.value = (await notebooksCache.load()) ?? []
    await refresh()
    status.value = notebooks.value.length ? 'Ready' : 'No notes yet, press Sync to connect'
  }

  /** New/Delete/Rename commit, which has to wait until the merge is finished (S5.5) */
  async function blockedByMerge(): Promise<boolean> {
    if (!merge.value) return false
    await dialog.error('Conflicts', 'Finish resolving conflicts first.')
    return true
  }

  /** Ask to save unsaved changes; false means the user cancelled */
  async function confirmLeave(question = 'Do you want to save the changes?'): Promise<boolean> {
    if (!dirty.value) return true
    const answer = await dialog.ask(
      'ntyonenote',
      `The text in "${page.value?.title || 'Untitled'}" has changed.\n\n${question}`,
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
        { label: 'Cancel', value: 'cancel' },
      ],
      'warning',
    )
    if (answer === 'cancel') return false
    if (answer === 'yes') return save()
    return true
  }

  /** Resolves true when `next` ends up selected (already selected counts too) */
  async function selectSection(next: Section): Promise<boolean> {
    if (section.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    section.value = next
    closePage()
    await refresh()
    return true
  }

  /** S4: signs in if needed, then fetch + merge + push for every _md section */
  async function sync() {
    if (!(await confirmLeave('Save them before syncing?'))) return
    const result = await run('Syncing...', async () => {
      if (!auth.userName) await auth.loadUser()
      return engine.sync()
    })
    if (!result) return
    notebooks.value = result.notebooks
    await notebooksCache.save(result.notebooks)

    // pages created offline got their remote ids
    const renamed = page.value && result.created.get(page.value.id)
    if (page.value && renamed) page.value = { ...page.value, id: renamed }
    await refresh()

    if (result.conflict) {
      status.value = `Conflicts in ${result.conflict.conflicts.length} page(s)`
      await openConflict(result.conflict.conflicts[0]!)
    } else {
      const titles = result.titleConflicts.length ? `, OneNote's title kept for ${result.titleConflicts.join(', ')}` : ''
      status.value = `Synced: ${result.fetched} fetched, ${result.pushed} pushed${titles}`
    }
    await reloadPage()
  }

  // --- converting regular sections (docs/convert-design.md) ---

  function convertSummary(result: ConvertResult, again: boolean): string {
    const list = (titles: string[]) =>
      titles
        .slice(0, 10)
        .map((t) => `  • ${t || 'Untitled'}`)
        .join('\n') + (titles.length > 10 ? `\n  • and ${titles.length - 10} more` : '')
    const lines = [`${result.created} page(s) converted into "${result.mirror.displayName}".`]
    if (again) lines.push(`${result.updated} updated, ${result.unchanged} unchanged.`)
    if (result.withWarnings) lines.push(`${result.withWarnings} with warnings: see the comment at the top of those pages.`)
    if (result.failed.length) {
      lines.push(`${result.failed.length} failed, convert again to retry:\n${list(result.failed.map((f) => `${f.title} (${f.reason})`))}`)
    }
    if (result.skipped.length) lines.push(`${result.skipped.length} deleted here, not recreated:\n${list(result.skipped)}`)
    if (result.gone.length) lines.push(`${result.gone.length} gone from the original, kept here:\n${list(result.gone)}`)
    if (result.cancelled) lines.push('Stopped. Convert again to continue where it stopped.')
    return lines.join('\n\n')
  }

  /** C5/C6: converts a regular section into its _md mirror, or adds to the mirror made before */
  async function convertSection(source: Section) {
    if (busy.value || (await blockedByMerge()) || !(await confirmLeave())) return
    const notebook = notebooks.value.find((n) => n.sections.some((s) => s.id === source.id))
    if (!notebook) return
    const mirror = await converter.mirrorOf(source.id)
    const name = mirror?.displayName ?? mirrorName(source.displayName, notebook.sections.map((s) => s.displayName))

    const answer = mirror
      ? await dialog.ask(
          'Convert Section',
          `"${source.displayName}" was converted into "${name}" on this device.\n\n` +
            'Add the pages that are missing there, or convert every page again? ' +
            `Converting again merges changes made in "${source.displayName}" into your edits.`,
          [
            { label: 'Add missing', value: 'missing' },
            { label: 'Convert again', value: 'again' },
            { label: 'Cancel', value: 'cancel' },
          ],
        )
      : await dialog.ask(
          'Convert Section',
          `Convert "${source.displayName}" into a new section "${name}"?\n\n` +
            `Every page is converted to markdown and created there. "${source.displayName}" itself stays untouched. ` +
            'Big sections take a while, you can stop and continue later.',
          [
            { label: 'Convert', value: 'missing' },
            { label: 'Cancel', value: 'cancel' },
          ],
        )
    if (answer === 'cancel') return

    const controller = new AbortController()
    converting.value = controller
    const again = answer === 'again'
    const target = {
      notebookId: notebook.id,
      notebookName: notebook.displayName,
      section: source,
      takenNames: notebook.sections.map((s) => s.displayName),
    }
    const result = await run('Converting...', async () => {
      if (!auth.userName) await auth.loadUser()
      return converter.convertSection(target, {
        again,
        signal: controller.signal,
        onProgress: (done, total, title) => {
          progress.value = { done, total }
          status.value = `Converting ${done} of ${total}: ${title || 'Untitled'}`
        },
      })
    })
    converting.value = null
    progress.value = null
    await refresh()
    if (!result) return

    // the mirror shows up right away, the next sync lists it from OneNote anyway
    if (!notebook.sections.some((s) => s.id === result.mirror.id)) {
      notebooks.value = notebooks.value.map((n) => (n.id === notebook.id ? { ...n, sections: [...n.sections, result.mirror] } : n))
      await notebooksCache.save(notebooks.value)
    }

    if (result.conflict) {
      status.value = `Conflicts in ${result.conflict.conflicts.length} page(s)`
      await openConflict(result.conflict.conflicts[0]!)
      return
    }
    await selectSection(result.mirror)
    status.value = `Converted: ${result.created} new, ${result.updated} updated, ${result.failed.length} failed`
    const icon = result.failed.length ? 'warning' : 'info'
    await dialog.ask('Convert Section', convertSummary(result, again), [{ label: 'OK', value: 'ok' }], icon)
  }

  function stopConverting() {
    converting.value?.abort()
  }

  async function openConflict(path: string) {
    const { sectionId, pageId } = parsePagePath(path)
    const target = tree.value.flatMap((n) => n.sections).find((s) => s.id === sectionId)
    if (target) await selectSection(target)
    const conflictedPage = pages.value.find((p) => p.id === pageId)
    if (conflictedPage) await openPage(conflictedPage)
    tab.value = 'conflicts'
  }

  function closePage() {
    page.value = null
    markdown.value = savedMarkdown.value = ''
  }

  /** Resolves true when `next` ends up open; pages not downloaded yet are fetched first (S6) */
  async function openPage(next: NotePage): Promise<boolean> {
    if (page.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    if (!next.downloaded) {
      if (await blockedByMerge()) return false
      const ok = await run(`Downloading ${next.title || 'Untitled'}...`, async () => {
        await engine.fetchPage(next.id)
        return true
      })
      await refresh()
      if (!ok) return false
    }
    closePage()
    page.value = { ...next, downloaded: true }
    if (tab.value === 'history' || (tab.value === 'conflicts' && !merge.value)) tab.value = 'edit'
    await reloadPage()
    return true
  }

  /** S5.1: a commit on main, or just the file while a merge is being resolved */
  async function save(): Promise<boolean> {
    const path = currentPath()
    if (!path) return false
    const text = markdown.value
    const ok = await run('Saving...', async () => {
      if (merge.value) await repo.writeFile(path, text)
      else await repo.commitFiles([{ path, content: text }], `Save ${page.value?.title || 'Untitled'}`)
      return true
    })
    if (!ok) return false
    savedMarkdown.value = text
    await refresh()
    status.value = merge.value ? 'Saved, finish the merge to commit' : 'Saved locally'
    return true
  }

  /** S5.2 */
  async function createPage(title: string) {
    const current = section.value
    if (!current || (await blockedByMerge()) || !(await confirmLeave())) return
    const id = newLocalId()
    const ok = await run('Creating page...', async () => {
      await commitLedger((l) => (l.pages[id] = { section: current.id, title, remote: false }), `Create ${title}`, [
        { path: pagePath(current.id, id), content: '' },
      ])
      return true
    })
    if (!ok) return
    await refresh()
    const created = pages.value.find((p) => p.id === id)
    if (created) await openPage(created)
  }

  /** S5.3; resolves false when the rename didn't happen */
  async function renamePage(title: string): Promise<boolean> {
    const current = page.value
    if (!current || title === current.title) return true
    if (await blockedByMerge()) return false
    const ok = await run('Renaming...', async () => {
      await commitLedger((l) => (l.pages[current.id]!.title = title), `Rename ${title}`)
      return true
    })
    if (!ok) return false
    page.value = { ...current, title }
    await refresh()
    return true
  }

  /** S5.4 */
  async function deletePage() {
    const current = page.value
    const currentSection = section.value
    if (!current || !currentSection || (await blockedByMerge())) return
    const answer = await dialog.ask(
      'Confirm Page Delete',
      `Are you sure you want to delete "${current.title || 'Untitled'}"?\n\nIt is deleted in OneNote on the next sync.`,
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      'warning',
    )
    if (answer !== 'yes') return
    await run('Deleting...', () =>
      commitLedger(
        (l) => {
          if (l.pages[current.id]?.remote) l.pages[current.id]!.deleted = true
          else delete l.pages[current.id]
        },
        `Delete ${current.title || 'Untitled'}`,
        [{ path: pagePath(currentSection.id, current.id), content: null }],
      ),
    )
    closePage()
    await refresh()
  }

  /** S7: drops the local copy of a section deleted in OneNote */
  async function removeSection() {
    const current = section.value
    if (!current || !sectionDeleted.value || (await blockedByMerge())) return
    const answer = await dialog.ask(
      'Remove Section',
      `"${current.displayName}" was deleted in OneNote.\n\nRemove its pages from this device too?`,
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      'warning',
    )
    if (answer !== 'yes') return
    await run('Removing...', () => engine.removeSection(current.id))
    closePage()
    section.value = null
    await refresh()
  }

  // --- conflicts (S8) ---

  async function resolveWith(side: 'mine' | 'remote') {
    const path = currentPath()
    if (!path) return
    // the other side is whatever is being merged: OneNote, or a conversion (C4.3)
    const content = await repo.readAt(side === 'mine' ? MAIN : (merge.value?.branch ?? connector.id), path)
    await repo.writeFile(path, content)
    markdown.value = savedMarkdown.value = content ?? ''
    tab.value = 'edit'
  }

  async function completeMerge() {
    const pending = merge.value
    if (!pending) return
    if (!(await confirmLeave('Save them before finishing the merge?'))) return
    for (const path of pending.conflicts) {
      if ((await repo.readFile(path))?.includes('<<<<<<<')) {
        await dialog.error('Conflicts', 'Some pages still contain conflict markers (<<<<<<<).')
        return
      }
    }
    await run('Finishing merge...', () => engine.completeMerge(pending))
    await refresh()
    status.value = 'Merge finished, press Sync to push'
    if (tab.value === 'conflicts') tab.value = 'edit'
    if (page.value && !downloaded.value.has(currentPath() ?? '')) closePage()
    else await reloadPage()
  }

  // --- history (S9) ---

  async function history(): Promise<HistoryEntry[]> {
    return page.value ? engine.history(page.value.id) : []
  }

  async function versionAt(entry: HistoryEntry): Promise<string> {
    return (await repo.readAtCommit(entry.oid, entry.path)) ?? ''
  }

  /** Puts an old version into the editor as an unsaved change */
  async function restore(entry: HistoryEntry) {
    markdown.value = await versionAt(entry)
    tab.value = 'edit'
  }

  return {
    notebooks,
    tree,
    section,
    sectionDeleted,
    pages,
    page,
    tab,
    markdown,
    unsynced,
    merge,
    lastSync,
    conflicted,
    busy,
    status,
    converting,
    progress,
    dirty,
    isSyncable,
    init,
    selectSection,
    sync,
    openPage,
    save,
    createPage,
    renamePage,
    deletePage,
    removeSection,
    convertSection,
    stopConverting,
    confirmLeave,
    resolveWith,
    completeMerge,
    history,
    versionAt,
    restore,
  }
})
