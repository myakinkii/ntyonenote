<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import MessageBox from '@/components/MessageBox.vue'
import PageEditor from '@/components/PageEditor.vue'
import PageList from '@/components/PageList.vue'
import SectionTree from '@/components/SectionTree.vue'
import TokenDialog from '@/components/TokenDialog.vue'
import { useAuthStore } from '@/stores/auth'
import { useDialogStore } from '@/stores/dialog'
import { useNotesStore } from '@/stores/notes'

const auth = useAuthStore()
const notes = useNotesStore()
const dialog = useDialogStore()

/** which pane is visible on narrow screens */
const pane = ref<'sections' | 'pages' | 'editor'>('sections')

// picks in the tree/list switch panes even when re-picking the current selection,
// this watch covers pages opened from elsewhere (e.g. New)
watch(
  () => notes.page?.id,
  (id) => id && (pane.value = 'editor'),
)

const windowTitle = computed(() => {
  const page = notes.page ? `${notes.dirty ? '*' : ''}${notes.page.title || 'Untitled'} - ` : ''
  return `${page}ntyonenote`
})

const PANES_KEY = 'ntyonenote.panes'

function storedPanes(): { sections: boolean; pages: boolean } {
  try {
    return { sections: true, pages: true, ...JSON.parse(localStorage.getItem(PANES_KEY) ?? '{}') }
  } catch {
    return { sections: true, pages: true }
  }
}

/** side panes shown on wide screens */
const shown = ref(storedPanes())

watch(
  shown,
  (value) => {
    try {
      localStorage.setItem(PANES_KEY, JSON.stringify(value))
    } catch {
      // storage unavailable, keep it for this run only
    }
  },
  { deep: true },
)

const columns = computed(() =>
  [
    shown.value.sections && 'minmax(160px, 220px)',
    shown.value.pages && 'minmax(200px, 280px)',
    '1fr',
  ]
    .filter(Boolean)
    .join(' '),
)

function back() {
  pane.value = pane.value === 'editor' ? 'pages' : 'sections'
}

async function connect() {
  try {
    await auth.loadUser()
  } catch {
    auth.tokenRejected()
    return
  }
  await notes.loadNotebooks()
}

async function newPage() {
  const title = await dialog.prompt('New Page', 'Page title:', 'New page')
  if (title?.trim()) await notes.createPage(title.trim())
}

function close() {
  dialog.ask(
    'ntyonenote',
    'It is now safe to turn off your computer.\n\n(Just kidding, there is nowhere to go.)',
    [{ label: 'OK', value: 'ok' }],
    'info',
  )
}

function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (notes.dirty) notes.save()
  }
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (notes.dirty) e.preventDefault()
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('beforeunload', onBeforeUnload)
  await auth.init()
  if (!auth.needsToken) connect()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<template>
  <div class="window app-window">
    <div class="title-bar">
      <div class="title-bar-text">📒 {{ windowTitle }}</div>
      <div class="title-bar-controls">
        <button aria-label="Minimize" />
        <button aria-label="Maximize" />
        <button aria-label="Close" @click="close" />
      </div>
    </div>

    <div class="window-body app-body">
      <div class="toolbar">
        <button v-if="pane !== 'sections'" class="back" @click="back">◀ Back</button>
        <button :disabled="!notes.section" @click="newPage">📄 New</button>
        <button :disabled="!notes.dirty" @click="notes.save()">💾 Save</button>
        <button :disabled="!notes.page" @click="notes.deletePage()">🗑️ Delete</button>
        <button :disabled="!notes.section" @click="notes.refreshPages()">🔄 Refresh</button>
        <span class="pane-toggles">
          <button
            :class="{ pressed: shown.sections }"
            :aria-pressed="shown.sections"
            @click="shown.sections = !shown.sections"
          >
            📓 Notebooks
          </button>
          <button
            :class="{ pressed: shown.pages }"
            :aria-pressed="shown.pages"
            @click="shown.pages = !shown.pages"
          >
            📝 Pages
          </button>
        </span>
      </div>

      <div class="panes" :data-pane="pane" :style="{ '--columns': columns }">
        <fieldset class="pane sections" :class="{ hidden: !shown.sections }">
          <legend>Notebooks</legend>
          <SectionTree @picked="pane = 'pages'" />
        </fieldset>
        <fieldset class="pane pages" :class="{ hidden: !shown.pages }">
          <legend>{{ notes.section?.displayName ?? 'Pages' }}</legend>
          <PageList @picked="pane = 'editor'" />
        </fieldset>
        <div class="pane editor">
          <PageEditor />
        </div>
      </div>
    </div>

    <div class="status-bar">
      <p class="status-bar-field">{{ notes.busy ? '⏳ ' : '' }}{{ notes.status }}</p>
      <p class="status-bar-field">{{ notes.dirty ? 'Modified' : notes.page ? 'Saved' : '' }}</p>
      <p class="status-bar-field">{{ notes.markdown.length }} chars</p>
      <p class="status-bar-field">👤 {{ auth.userName || 'Offline' }}</p>
    </div>
  </div>

  <TokenDialog v-if="auth.needsToken" @connected="connect" />
  <MessageBox />
</template>

<style scoped>
.app-window {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--pane-gap);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.toolbar button {
  min-width: 0;
}

.panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: var(--columns);
  gap: var(--pane-gap);
}

.pane {
  min-width: 0;
  min-height: 0;
  margin: 0;
}

fieldset.pane {
  display: flex;
  flex-direction: column;
}

fieldset.pane > :deep(:not(legend)) {
  flex: 1;
  min-height: 0;
}

.back {
  display: none;
}

.pane-toggles {
  display: flex;
  gap: 4px;
  margin-left: auto;
}

/* 98-style latched button */
.pane-toggles button.pressed {
  box-shadow:
    inset -1px -1px #fff,
    inset 1px 1px #0a0a0a,
    inset -2px -2px #dfdfdf,
    inset 2px 2px grey;
  background-image: repeating-conic-gradient(#fff 0% 25%, silver 0% 50%);
  background-size: 2px 2px;
}

.status-bar-field:first-child {
  flex: 3;
}

/* toggles are for wide screens, phones navigate with Back */
@media (min-width: 761px) {
  .pane.hidden {
    display: none;
  }
}

/* phones: one pane at a time */
@media (max-width: 760px) {
  .panes {
    grid-template-columns: 1fr;
  }

  .panes[data-pane='sections'] .pane:not(.sections),
  .panes[data-pane='pages'] .pane:not(.pages),
  .panes[data-pane='editor'] .pane:not(.editor) {
    display: none;
  }

  .back {
    display: inline-block;
  }

  .pane-toggles {
    display: none;
  }

  .status-bar-field:nth-child(3) {
    display: none;
  }
}
</style>
