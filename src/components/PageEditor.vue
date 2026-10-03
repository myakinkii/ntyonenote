<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

import { useNotesStore } from '@/stores/notes'

const notes = useNotesStore()

const tab = ref<'edit' | 'preview'>('edit')
const title = ref('')

watch(
  () => notes.page,
  (page) => (title.value = page?.title ?? ''),
  { immediate: true },
)

const preview = computed(() =>
  tab.value === 'preview' ? DOMPurify.sanitize(marked.parse(notes.markdown, { async: false })) : '',
)

function commitTitle() {
  const next = title.value.trim()
  if (next) notes.renamePage(next)
  else title.value = notes.page?.title ?? ''
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
      <li role="tab" :aria-selected="tab === 'edit'">
        <a href="#" @click.prevent="tab = 'edit'">Edit</a>
      </li>
      <li role="tab" :aria-selected="tab === 'preview'">
        <a href="#" @click.prevent="tab = 'preview'">Preview</a>
      </li>
    </menu>
    <div class="window tab-panel" role="tabpanel">
      <div class="window-body">
        <textarea
          v-if="tab === 'edit'"
          v-model="notes.markdown"
          class="source"
          spellcheck="false"
          :placeholder="notes.hasMagic ? '' : 'Empty page. Type some markdown and save.'"
        />
        <!-- eslint-disable-next-line vue/no-v-html -- sanitized by DOMPurify -->
        <div v-else class="preview" v-html="preview" />
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

.source,
.preview {
  flex: 1;
  width: 100%;
  min-height: 0;
}

.source {
  resize: none;
  font-family: 'Fixedsys Excelsior', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.35;
  tab-size: 4;
}

.preview {
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
  .source,
  .title-row input {
    font-size: 16px;
  }
}
</style>
