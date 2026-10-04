<script setup lang="ts">
import { computed } from 'vue'

import { useNotesStore } from '@/stores/notes'

const notes = useNotesStore()

const conflictedPages = computed(() => notes.pages.filter((p) => notes.conflicted.has(p.id)))
const current = computed(() => !!notes.page && notes.conflicted.has(notes.page.id))
</script>

<template>
  <div class="conflicts">
    <p>
      ⚠️ The same text was changed here and in OneNote. Pick a version for each page, or edit the
      merged text by hand (remove the <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code>,
      <code>=======</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> lines), then finish the
      merge.
    </p>

    <fieldset v-if="current">
      <legend>{{ notes.page?.title || 'Untitled' }}</legend>
      <div class="actions">
        <button @click="notes.resolveWith('mine')">💻 Keep mine</button>
        <button @click="notes.resolveWith('remote')">
          {{ notes.merge?.branch === 'import' ? '🔄 Keep converted' : "☁️ Keep OneNote's" }}
        </button>
        <button @click="notes.tab = 'edit'">✏️ Edit merged text</button>
      </div>
    </fieldset>

    <div class="sunken-panel list">
      <table class="interactive">
        <thead>
          <tr>
            <th>Pages in conflict</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="page in conflictedPages"
            :key="page.id"
            :class="{ highlighted: notes.page?.id === page.id }"
            @click="notes.openPage(page)"
          >
            <td>⚠️ {{ page.title || 'Untitled' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section class="buttons">
      <button class="default" @click="notes.completeMerge()">✅ Finish merge</button>
    </section>
  </div>
</template>

<style scoped>
.conflicts {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

p {
  margin: 0;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.list {
  flex: 1;
  min-height: 80px;
}

table {
  width: 100%;
}

.buttons {
  display: flex;
  justify-content: flex-end;
}
</style>
