<script setup lang="ts">
import { isMdSection, type Section } from '@/graph/client'
import { useNotesStore } from '@/stores/notes'

const emit = defineEmits<{ picked: [] }>()

const notes = useNotesStore()

async function pick(section: Section) {
  if (isMdSection(section) && (await notes.selectSection(section))) emit('picked')
}
</script>

<template>
  <ul class="tree-view section-tree">
    <li v-if="!notes.notebooks.length" class="empty">
      {{ notes.busy ? 'Loading...' : 'No notebooks' }}
    </li>
    <li v-for="notebook in notes.notebooks" :key="notebook.id">
      <details open>
        <summary>📓 {{ notebook.displayName }}</summary>
        <ul>
          <li
            v-for="section in notebook.sections"
            :key="section.id"
            :class="{
              selected: notes.section?.id === section.id,
              foreign: !isMdSection(section),
            }"
            :title="isMdSection(section) ? section.displayName : 'Not an _md section, read only in OneNote'"
            @click="pick(section)"
          >
            {{ isMdSection(section) ? '📁' : '🔒' }} {{ section.displayName }}
          </li>
        </ul>
      </details>
    </li>
  </ul>
</template>

<style scoped>
.section-tree {
  height: 100%;
  overflow: auto;
  margin: 0;
}

li li {
  cursor: pointer;
  padding: 1px 2px;
  white-space: nowrap;
}

.selected {
  background: navy;
  color: white;
}

.foreign {
  color: grey;
  cursor: default;
}

.empty {
  color: grey;
}
</style>
