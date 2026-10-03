import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { GraphError, type Notebook, type PageSummary, type Section } from '@/graph/client'
import { useAuthStore } from './auth'
import { useDialogStore } from './dialog'

export const useNotesStore = defineStore('notes', () => {
  const auth = useAuthStore()
  const dialog = useDialogStore()

  const notebooks = ref<Notebook[]>([])
  const section = ref<Section | null>(null)
  const pages = ref<PageSummary[]>([])
  const page = ref<PageSummary | null>(null)

  const markdown = ref('')
  const savedMarkdown = ref('')
  /** false when the page has no magic paragraph yet (first save appends one) */
  const hasMagic = ref(false)

  const busy = ref(0)
  const status = ref('Ready')

  const dirty = computed(() => page.value !== null && markdown.value !== savedMarkdown.value)

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

  /** Ask to save unsaved changes; false means the user cancelled */
  async function confirmLeave(): Promise<boolean> {
    if (!dirty.value) return true
    const answer = await dialog.ask(
      'ntyonenote',
      `The text in "${page.value?.title || 'Untitled'}" has changed.\n\nDo you want to save the changes?`,
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

  async function loadNotebooks() {
    await run('Loading notebooks...', async () => {
      notebooks.value = await auth.graph.notebooks()
    })
  }

  /** Resolves true when `next` ends up selected (already selected counts too) */
  async function selectSection(next: Section): Promise<boolean> {
    if (section.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    section.value = next
    closePage()
    pages.value = []
    await run(`Loading ${next.displayName}...`, async () => {
      pages.value = await auth.graph.pages(next)
    })
    return true
  }

  async function refreshPages() {
    const current = section.value
    if (!current) return
    await run('Refreshing...', async () => {
      pages.value = await auth.graph.pages(current)
    })
  }

  function closePage() {
    page.value = null
    markdown.value = savedMarkdown.value = ''
    hasMagic.value = false
  }

  /** Resolves true when `next` ends up open (already open counts too) */
  async function openPage(next: PageSummary): Promise<boolean> {
    if (page.value?.id === next.id) return true
    if (!(await confirmLeave())) return false
    closePage()
    page.value = next
    await run(`Opening ${next.title || 'Untitled'}...`, async () => {
      const content = await auth.graph.pageContent(next)
      // user may have clicked another page meanwhile
      if (page.value?.id !== next.id) return
      markdown.value = savedMarkdown.value = content.markdown
      hasMagic.value = content.id !== null
    })
    return true
  }

  async function save(): Promise<boolean> {
    const current = page.value
    if (!current) return false
    const text = markdown.value
    const content = await run('Saving...', () => auth.graph.savePageContent(current, text))
    if (!content) return false
    hasMagic.value = content.id !== null
    savedMarkdown.value = content.markdown
    if (content.markdown === text) {
      status.value = 'Saved'
    } else {
      // codec could not round-trip something (e.g. tabs), show what OneNote really stored
      // unless the user kept typing while saving
      if (markdown.value === text) markdown.value = content.markdown
      status.value = 'Saved (OneNote adjusted the text)'
    }
    return true
  }

  async function createPage(title: string) {
    const current = section.value
    if (!current || !(await confirmLeave())) return
    const created = await run('Creating page...', () =>
      auth.graph.createPage(current, title, `# ${title}\n\n`),
    )
    if (!created) return
    pages.value = [created, ...pages.value]
    await openPage(created)
  }

  async function renamePage(title: string) {
    const current = page.value
    if (!current || title === current.title) return
    await run('Renaming...', async () => {
      await auth.graph.renamePage(current, title)
      current.title = title
    })
  }

  async function deletePage() {
    const current = page.value
    if (!current) return
    const answer = await dialog.ask(
      'Confirm Page Delete',
      `Are you sure you want to delete "${current.title || 'Untitled'}"?`,
      [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
      'warning',
    )
    if (answer !== 'yes') return
    await run('Deleting...', async () => {
      await auth.graph.deletePage(current)
      pages.value = pages.value.filter((p) => p.id !== current.id)
      closePage()
    })
  }

  return {
    notebooks,
    section,
    pages,
    page,
    markdown,
    hasMagic,
    busy,
    status,
    dirty,
    loadNotebooks,
    selectSection,
    refreshPages,
    openPage,
    save,
    createPage,
    renamePage,
    deletePage,
    confirmLeave,
  }
})
