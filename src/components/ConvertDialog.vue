<script setup lang="ts">
import { computed } from 'vue'

import PixelIcon from '@/components/PixelIcon.vue'
import { useNotesStore } from '@/stores/notes'

// Blocks the app while a section is converted: the pipeline holds the ledger for the whole run,
// so nothing else may commit meanwhile (docs/convert-design.md C5)
const notes = useNotesStore()

/** pages finished, so the bar is full only when the last one is done */
const percent = computed(() => {
  const c = notes.conversion
  return c?.total ? (100 * Math.max(c.done - 1, 0)) / c.total : 0
})
</script>

<template>
  <div class="overlay">
    <div class="window convert-dialog" role="dialog" aria-label="Converting">
      <div class="title-bar">
        <div class="title-bar-text">Converting...</div>
      </div>
      <div class="window-body">
        <div class="animation" aria-hidden="true">
          <PixelIcon name="folder" :size="32" />
          <PixelIcon class="page" name="page" :size="20" />
          <PixelIcon name="folder" :size="32" />
        </div>
        <p class="current">{{ notes.conversion?.total ? notes.conversion.title || 'Untitled' : 'Reading the section...' }}</p>
        <p>From "{{ notes.conversion?.from }}" to "{{ notes.conversion?.to }}"</p>
        <div class="progress-indicator segmented">
          <span class="progress-indicator-bar" :style="{ width: `${percent}%` }" />
        </div>
        <p class="counter">
          {{ notes.conversion?.total ? `Page ${notes.conversion.done} of ${notes.conversion.total}` : '\u00a0' }}
        </p>
        <section class="buttons">
          <button :disabled="notes.stopping" @click="notes.stopConverting()">
            {{ notes.stopping ? 'Stopping...' : 'Stop' }}
          </button>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  z-index: 95;
  padding: 16px;
}

.convert-dialog {
  width: min(360px, 100%);
}

/* Win98's flying paper, between two folders */
.animation {
  position: relative;
  display: flex;
  justify-content: space-between;
  padding: 4px 24px 8px;
}

.page {
  position: absolute;
  top: 10px;
  animation: fly 1.4s linear infinite;
}

/* from the left folder to the right one, whatever the dialog's width */
@keyframes fly {
  0% {
    left: 40px;
    transform: translateY(6px);
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  50% {
    transform: translateY(-8px);
  }
  85% {
    opacity: 1;
  }
  100% {
    left: calc(100% - 70px);
    transform: translateY(6px);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .page {
    display: none;
  }
}

.current {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-indicator {
  height: 20px;
  padding: 3px;
  margin-top: 8px;
}

.counter {
  margin-top: 4px;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
