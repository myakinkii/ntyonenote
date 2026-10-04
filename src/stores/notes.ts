import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { GraphError, type Notebook, type PageSummary, type Section } from '@/graph/client'
import { MAIN, ONENOTE, pagePath, type PendingMerge } from '@/sync/repo'
import { meta, notebooksCache, repo } from '@/sync/storage'
import { createSync } from '@/sync/sync'
import { useAuthStore } from './auth'
import { useDialogStore } from './dialog'

export type EditorTab = 'edit' | 'preview' | 'history' | 'conflicts'

export const useNotesStore = defineStore('notes', () => {
  const auth = useAuthStore()
  const dialog = useDialogStore()
  const engine = createSync(repo, auth.graph, meta)

  const notebooks = ref<Notebook[]>([])
  const section = ref<Section | null>(null)
  const pages = ref<PageSummary[]>([])
  const page = ref<PageSummary | null>(null)
  const tab = ref<EditorTab>('edit')

  const markdown = ref('')
  const savedMarkdown = ref('')

  /** page ids in the current section whose local version isn't in OneNote yet */
  const unsynced = ref<string[]>([])
  const merge = ref<PendingMerge | null>(null)

  const busy = ref(0)
  const status = ref('Ready')

  const dirty = computed(() => page.value !== null && markdown.value !== savedMarkdown.value)
  const conflicted = computed(
    () => new Set(merge.value?.conflicts.map((path) => path.slice(path.indexOf('/') + 1, -3)) ?? []),
  )

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

  async function refreshSyncState() {
    merge.value = await repo.pendingMerge()
    unsynced.value = section.value ? await repo.unsynced(section.value.id) : []
  }

  /** Re-reads the open page from disk unless the user has unsaved edits */
  async function reloadPage() {
    const path = currentPath()
    if (!path || dirty.value) return
    markdown.value = savedMarkdown.value = (await repo.readPage(path)) ?? ''
  }

  /** New/Delete fetch from OneNote, which has to wait until the merge is finished */
  async function blockedByMerge(): Promise<boolean> {
    if (!merge.value) return false
    await dialog.error('Conflicts', 'Finish resolving conflicts first.')
    return true
  }

  async function init() {
    await repo.init()
    await refreshSyncState()
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

  /** Notebooks from Graph, or the last known list when offline */
  async function loadNotebooks() {
    busy.value++
    status.value = 'Loading notebooks...'
    try {
      notebooks.value = await auth.graph.notebooks()
      await notebooksCache.save(notebooks.value)
      status.value = 'Ready'
    } catch (e) {
      if (e instanceof GraphError && e.status === 401) auth.tokenRejected()
      const cached = await notebooksCache.load()
      if (cached) notebooks.value = cached
      status.value = cached ? 'Offline: showing local notes' : 'Offline'
    } finally {
      busy.value--
    }
  }

  /** Resolves true when `next` ends up selected (already selected counts too) */
  async function selectSection(next: Section): Promise<boolean> {
    if (section.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    section.value = next
    closePage()
    const known = await meta.load(next.id)
    pages.value = known?.pages ?? []
    await refreshSyncState()
    // never synced: fetch it once so there is something to show
    if (!known) await sync()
    return true
  }

  /** fetch + 3-way merge + upload for the current section */
  async function sync() {
    const current = section.value
    if (!current || !(await confirmLeave('Save them before syncing?'))) return
    const result = await run(`Syncing ${current.displayName}...`, () => engine.sync(current))
    if (!result) return
    pages.value = result.pages
    await refreshSyncState()
    if (result.conflict) {
      status.value = `Conflicts in ${result.conflict.conflicts.length} page(s)`
      const first = result.pages.find((p) => conflicted.value.has(p.id))
      if (first) await openPage(first)
      tab.value = 'conflicts'
    } else {
      status.value = `Synced: ${result.pulled} fetched, ${result.pushed} uploaded`
    }
    await reloadPage()
  }

  function closePage() {
    page.value = null
    markdown.value = savedMarkdown.value = ''
  }

  /** Resolves true when `next` ends up open (already open counts too) */
  async function openPage(next: PageSummary): Promise<boolean> {
    if (page.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    closePage()
    page.value = next
    if (tab.value === 'history' || (tab.value === 'conflicts' && !merge.value)) tab.value = 'edit'
    await reloadPage()
    return true
  }

  /** Saves locally: a commit on main, or just the file while a merge is being resolved */
  async function save(): Promise<boolean> {
    const path = currentPath()
    if (!path) return false
    const text = markdown.value
    const ok = await run('Saving...', async () => {
      await repo.writePage(path, text)
      if (!merge.value) await repo.commitWorktree([path], `Save ${page.value?.title || 'Untitled'}`)
      return true
    })
    if (!ok) return false
    savedMarkdown.value = text
    await refreshSyncState()
    status.value = merge.value ? 'Saved, finish the merge to commit' : 'Saved locally'
    return true
  }

  async function createPage(title: string) {
    const current = section.value
    if (!current || (await blockedByMerge()) || !(await confirmLeave())) return
    const created = await run('Creating page...', async () => {
      const page = await auth.graph.createPage(current, title, `# ${title}\n\n`)
      const pulled = await engine.pull(current)
      pages.value = pulled.pages
      return page
    })
    if (!created) return
    await refreshSyncState()
    const listed = pages.value.find((p) => p.id === created.id)
    if (listed) await openPage(listed)
  }

  async function renamePage(title: string) {
    const current = page.value
    const currentSection = section.value
    if (!current || !currentSection || title === current.title) return
    await run('Renaming...', async () => {
      await auth.graph.renamePage(current, title)
      current.title = title
      await meta.save(currentSection.id, { pages: pages.value })
    })
  }

  async function deletePage() {
    const current = page.value
    const currentSection = section.value
    if (!current || !currentSection || (await blockedByMerge())) return
    const unsaved = unsynced.value.includes(current.id) ? '\n\nIts changes that are not synced yet will be lost.' : ''
    const answer = await dialog.ask(
      'Confirm Page Delete',
      `Are you sure you want to delete "${current.title || 'Untitled'}"?${unsaved}`,
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      'warning',
    )
    if (answer !== 'yes') return
    await run('Deleting...', async () => {
      await auth.graph.deletePage(current)
      const path = pagePath(currentSection.id, current.id)
      await repo.deletePage(path)
      await repo.commitWorktree([path], `Delete ${current.title || 'Untitled'}`)
      pages.value = (await engine.pull(currentSection)).pages
      closePage()
    })
    await refreshSyncState()
  }

  // --- conflicts ---

  async function resolveWith(side: 'mine' | 'onenote') {
    const path = currentPath()
    if (!path) return
    const content = await repo.readAt(side === 'mine' ? MAIN : ONENOTE, path)
    if (content === null) await repo.deletePage(path)
    else await repo.writePage(path, content)
    markdown.value = savedMarkdown.value = content ?? ''
    tab.value = 'edit'
  }

  async function completeMerge() {
    const pending = merge.value
    if (!pending) return
    for (const path of pending.conflicts) {
      if ((await repo.readPage(path))?.includes('<<<<<<<')) {
        await dialog.error('Conflicts', 'Some pages still contain conflict markers (<<<<<<<).')
        return
      }
    }
    if (!(await confirmLeave('Save them before finishing the merge?'))) return
    await run('Finishing merge...', () => repo.completeMerge(pending))
    await refreshSyncState()
    status.value = 'Merge finished, press Sync to upload'
    if (tab.value === 'conflicts') tab.value = 'edit'
  }

  // --- history ---

  async function history() {
    const path = currentPath()
    return path ? repo.history(path) : []
  }

  async function versionAt(oid: string): Promise<string> {
    const path = currentPath()
    return (path && (await repo.readAtCommit(oid, path))) ?? ''
  }

  /** Puts an old version into the editor as an unsaved change */
  async function restore(oid: string) {
    markdown.value = await versionAt(oid)
    tab.value = 'edit'
  }

  return {
    notebooks,
    section,
    pages,
    page,
    tab,
    markdown,
    unsynced,
    merge,
    conflicted,
    busy,
    status,
    dirty,
    init,
    loadNotebooks,
    selectSection,
    sync,
    openPage,
    save,
    createPage,
    renamePage,
    deletePage,
    confirmLeave,
    resolveWith,
    completeMerge,
    history,
    versionAt,
    restore,
  }
})
