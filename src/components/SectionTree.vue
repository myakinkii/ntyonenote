<script setup lang="ts">
import type { Section } from '@/sync/connector'
import { useNotesStore } from '@/stores/notes'

const emit = defineEmits<{ picked: [] }>()

const notes = useNotesStore()

async function pick(section: Section) {
  if (notes.isSyncable(section) && (await notes.selectSection(section))) emit('picked')
}
</script>

<template>
  <ul class="tree-view section-tree">
    <li v-if="!notes.tree.length" class="empty">
      {{ notes.busy ? 'Syncing...' : 'No notebooks yet, press 🔄 Sync' }}
    </li>
    <li v-for="notebook in notes.tree" :key="notebook.id">
      <details open>
        <summary>📓 {{ notebook.displayName }}</summary>
        <ul>
          <li
            v-for="section in notebook.sections"
            :key="section.id"
            :class="{
              selected: notes.section?.id === section.id,
              foreign: !notes.isSyncable(section),
            }"
            :title="notes.isSyncable(section) ? section.displayName : 'Not an _md section, read only in OneNote'"
            @click="pick(section)"
          >
            {{ notes.isSyncable(section) ? '📁' : '🔒' }} {{ section.displayName }}
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
