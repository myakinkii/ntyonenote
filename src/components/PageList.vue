<script setup lang="ts">
import type { PageSummary } from '@/graph/client'
import { useNotesStore } from '@/stores/notes'

const emit = defineEmits<{ picked: [] }>()

const notes = useNotesStore()

async function pick(page: PageSummary) {
  if (await notes.openPage(page)) emit('picked')
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
</script>

<template>
  <div class="sunken-panel page-list">
    <table class="interactive">
      <thead>
        <tr>
          <th>Name</th>
          <th class="modified">Modified</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="!notes.section">
          <td colspan="2" class="empty">Select an _md section</td>
        </tr>
        <tr v-else-if="!notes.pages.length">
          <td colspan="2" class="empty">{{ notes.busy ? 'Loading...' : '(empty)' }}</td>
        </tr>
        <tr
          v-for="page in notes.pages"
          :key="page.id"
          :class="{ highlighted: notes.page?.id === page.id }"
          @click="pick(page)"
        >
          <td>📝 {{ page.title || 'Untitled' }}</td>
          <td class="modified">{{ formatDate(page.lastModifiedDateTime) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.page-list {
  height: 100%;
  overflow: auto;
}

table {
  width: 100%;
}

td,
th {
  white-space: nowrap;
}

td:first-child {
  max-width: 0;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.modified {
  text-align: right;
}

.empty {
  color: grey;
}
</style>
