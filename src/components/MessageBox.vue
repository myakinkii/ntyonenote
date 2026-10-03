<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

import { useDialogStore } from '@/stores/dialog'

const dialog = useDialogStore()
const root = ref<HTMLElement | null>(null)

const ICONS = { question: '❓', warning: '⚠️', error: '❌', info: 'ℹ️' }

watch(
  () => dialog.current,
  async (current) => {
    if (!current) return
    await nextTick()
    root.value?.querySelector<HTMLElement>('input, button.default')?.focus()
  },
)

function onKey(e: KeyboardEvent) {
  const current = dialog.current
  if (!current) return
  if (e.key === 'Escape') {
    // last button is the "get me out" one: Cancel / No / OK
    const last = current.buttons[current.buttons.length - 1]
    if (last) current.resolve(last.value)
  } else if (e.key === 'Enter' && current.input) {
    current.resolve('ok')
  }
}
</script>

<template>
  <div v-if="dialog.current" class="overlay" @keydown="onKey">
    <div ref="root" class="window message-box" role="dialog" :aria-label="dialog.current.title">
      <div class="title-bar">
        <div class="title-bar-text">{{ dialog.current.title }}</div>
        <div class="title-bar-controls">
          <button
            aria-label="Close"
            @click="dialog.current.resolve(dialog.current.buttons.at(-1)?.value ?? 'cancel')"
          />
        </div>
      </div>
      <div class="window-body">
        <div class="content">
          <span class="icon">{{ ICONS[dialog.current.icon] }}</span>
          <div class="text">
            <p>{{ dialog.current.message }}</p>
            <input v-if="dialog.current.input" v-model="dialog.current.input.value" type="text" />
          </div>
        </div>
        <section class="buttons">
          <button
            v-for="(button, i) in dialog.current.buttons"
            :key="button.value"
            :class="{ default: i === 0 }"
            @click="dialog.current.resolve(button.value)"
          >
            {{ button.label }}
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
  z-index: 100;
  padding: 16px;
}

.message-box {
  width: min(340px, 100%);
}

.content {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  padding: 8px 4px;
}

.icon {
  font-size: 28px;
  line-height: 1;
}

.text {
  flex: 1;
  min-width: 0;
}

.text p {
  white-space: pre-line;
  margin: 4px 0 8px;
}

.text input {
  width: 100%;
}

.buttons {
  display: flex;
  justify-content: center;
  gap: 6px;
}

@media (pointer: coarse) {
  .text input {
    font-size: 16px;
  }
}
</style>
