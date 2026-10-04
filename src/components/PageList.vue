<script setup lang="ts">
import { useNotesStore, type NotePage } from '@/stores/notes'

const emit = defineEmits<{ picked: [] }>()

const notes = useNotesStore()

async function pick(page: NotePage) {
  if (await notes.openPage(page)) emit('picked')
}

/** remote versions are dates for OneNote; pages created offline have none yet */
function formatVersion(version?: string) {
  const date = version ? new Date(version) : null
  if (!date || isNaN(date.getTime())) return version ? '' : 'new'
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}
</script>

<template>
  <div class="page-list-wrap">
  <div v-if="notes.sectionDeleted" class="deleted-banner">
    <span>⚠️ Deleted in OneNote</span>
    <button @click="notes.removeSection()">Remove local copy</button>
  </div>
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
          <td>
            {{ notes.conflicted.has(page.id) ? '⚠️' : page.downloaded ? '📝' : '☁️' }}
            {{ page.title || 'Untitled' }}
            <span v-if="notes.unsynced.includes(page.id)" title="Not synced yet">↑</span>
          </td>
          <td class="modified">{{ formatVersion(page.modified) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
  </div>
</template>

<style scoped>
.page-list-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.deleted-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.page-list {
  flex: 1;
  min-height: 0;
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
