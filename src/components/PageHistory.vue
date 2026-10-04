<script setup lang="ts">
import { ref, watch } from 'vue'

import { useNotesStore } from '@/stores/notes'
import type { HistoryEntry } from '@/sync/sync'

const notes = useNotesStore()

const commits = ref<HistoryEntry[]>([])
const selected = ref<HistoryEntry | null>(null)

const FROM = { local: '💻 Local', remote: '☁️ OneNote', merge: '🔀 Merge', convert: '🔄 Convert' }
const text = ref('')

watch(
  () => notes.page?.id,
  async () => {
    selected.value = null
    text.value = ''
    commits.value = await notes.history()
  },
  { immediate: true },
)

async function pick(entry: HistoryEntry) {
  selected.value = entry
  text.value = await notes.versionAt(entry)
}

const formatDate = (date: Date) =>
  date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
</script>

<template>
  <div class="page-history">
    <div class="sunken-panel commits">
      <table class="interactive">
        <thead>
          <tr>
            <th>Date</th>
            <th>From</th>
            <th class="message">Change</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!commits.length">
            <td colspan="3" class="empty">No saved versions yet</td>
          </tr>
          <tr
            v-for="commit in commits"
            :key="commit.oid"
            :class="{ highlighted: selected?.oid === commit.oid }"
            @click="pick(commit)"
          >
            <td>{{ formatDate(commit.date) }}</td>
            <td>{{ FROM[commit.from] }}</td>
            <td class="message">{{ commit.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <pre class="version">{{ selected ? text : 'Pick a version to see it.' }}</pre>
    <section class="buttons">
      <button :disabled="!selected" @click="selected && notes.restore(selected)">
        ↩️ Restore this version
      </button>
    </section>
  </div>
</template>

<style scoped>
.page-history {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.commits {
  height: 40%;
  min-height: 80px;
}

table {
  width: 100%;
}

.message {
  width: 100%;
}

.empty {
  color: grey;
}

.version {
  flex: 1;
  min-height: 0;
  overflow: auto;
  white-space: pre-wrap;
  font-family: 'Fixedsys Excelsior', 'Courier New', monospace;
  font-size: 13px;
}

.buttons {
  display: flex;
  justify-content: flex-end;
}
</style>
