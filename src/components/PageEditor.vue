<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

import ConflictsPanel from '@/components/ConflictsPanel.vue'
import MarkdownEditor from '@/components/MarkdownEditor.vue'
import PageHistory from '@/components/PageHistory.vue'
import { useNotesStore } from '@/stores/notes'

const notes = useNotesStore()

const title = ref('')

watch(
  () => notes.page,
  (page) => (title.value = page?.title ?? ''),
  { immediate: true },
)

const preview = computed(() =>
  notes.tab === 'preview' ? DOMPurify.sanitize(marked.parse(notes.markdown, { async: false })) : '',
)

async function commitTitle() {
  const next = title.value.trim()
  if (!next || !(await notes.renamePage(next))) title.value = notes.page?.title ?? ''
}
</script>

<template>
  <div v-if="notes.page" class="editor">
    <div class="field-row title-row">
      <label for="page-title">Title:</label>
      <input
        id="page-title"
        v-model="title"
        type="text"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
        @blur="commitTitle"
      />
    </div>

    <menu role="tablist">
      <li role="tab" :aria-selected="notes.tab === 'edit'">
        <a href="#" @click.prevent="notes.tab = 'edit'">Edit</a>
      </li>
      <li role="tab" :aria-selected="notes.tab === 'preview'">
        <a href="#" @click.prevent="notes.tab = 'preview'">Preview</a>
      </li>
      <li role="tab" :aria-selected="notes.tab === 'history'">
        <a href="#" @click.prevent="notes.tab = 'history'">History</a>
      </li>
      <li v-if="notes.merge" role="tab" :aria-selected="notes.tab === 'conflicts'">
        <a href="#" @click.prevent="notes.tab = 'conflicts'">⚠️ Conflicts</a>
      </li>
    </menu>
    <div class="window tab-panel" role="tabpanel">
      <div class="window-body">
        <MarkdownEditor v-if="notes.tab === 'edit'" v-model="notes.markdown" />
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify -->
        <div v-else-if="notes.tab === 'preview'" class="preview" v-html="preview" />
        <PageHistory v-else-if="notes.tab === 'history'" />
        <ConflictsPanel v-else />
      </div>
    </div>
  </div>
  <div v-else class="editor-empty">
    <p>Pick a page, or create a new one.</p>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.title-row {
  margin-bottom: 8px;
}

.title-row input {
  flex: 1;
  min-width: 0;
}

.tab-panel {
  flex: 1;
  min-height: 0;
  display: flex;
}

.tab-panel .window-body {
  flex: 1;
  display: flex;
  margin: 6px;
  min-height: 0;
}

.preview {
  flex: 1;
  width: 100%;
  min-height: 0;
  overflow: auto;
  background: white;
  padding: 4px 12px;
  box-shadow:
    inset -1px -1px #fff,
    inset 1px 1px grey,
    inset -2px -2px #dfdfdf,
    inset 2px 2px #0a0a0a;
  font-size: 13px;
  line-height: 1.45;
  user-select: text;
}

.preview :deep(pre) {
  background: #f0f0f0;
  padding: 6px;
  overflow: auto;
}

.preview :deep(img) {
  max-width: 100%;
}

.editor-empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: #444;
}

/* iOS zooms into inputs below 16px */
@media (pointer: coarse) {
  .title-row input {
    font-size: 16px;
  }
}
</style>
