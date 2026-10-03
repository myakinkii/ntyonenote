<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { tags as t } from '@lezer/highlight'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const host = ref<HTMLElement | null>(null)
let view: EditorView | null = null

const highlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: 'bold', color: 'navy' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: '#0000ee', textDecoration: 'underline' },
  { tag: t.quote, color: '#555' },
  { tag: t.monospace, color: '#800000' },
  { tag: [t.processingInstruction, t.list], color: '#808000' },
])

// white sunken 98.css field
const theme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'white',
    fontSize: '13px',
    boxShadow: 'inset -1px -1px #fff, inset 1px 1px grey, inset -2px -2px #dfdfdf, inset 2px 2px #0a0a0a',
    padding: '2px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: "'Fixedsys Excelsior', 'Courier New', monospace", lineHeight: '1.35' },
  '.cm-gutters': { backgroundColor: '#e4e4e4', color: 'grey', borderRight: '1px solid #a0a0a0' },
})

onMounted(() => {
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        markdown(),
        syntaxHighlighting(highlight),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        }),
      ],
    }),
  })
})

// page loaded or OneNote adjusted the text: swap the content, kept out of undo history
watch(
  () => props.modelValue,
  (value) => {
    if (!view || value === view.state.doc.toString()) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      annotations: Transaction.addToHistory.of(false),
    })
  },
)

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="host" class="markdown-editor" />
</template>

<style scoped>
.markdown-editor {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.markdown-editor :deep(.cm-editor) {
  flex: 1;
  min-height: 0;
}

/* iOS zooms into inputs below 16px */
@media (pointer: coarse) {
  .markdown-editor :deep(.cm-editor) {
    font-size: 16px;
  }
}
</style>
