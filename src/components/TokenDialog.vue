<script setup lang="ts">
import { ref } from 'vue'

import { useAuthStore } from '@/stores/auth'

const emit = defineEmits<{ connected: [] }>()

const auth = useAuthStore()
const value = ref('')

function submit() {
  if (!value.value.trim()) return
  auth.setToken(value.value)
  value.value = ''
  emit('connected')
}
</script>

<template>
  <div class="overlay">
    <div class="window token-dialog" role="dialog" aria-label="Connect to OneNote">
      <div class="title-bar">
        <div class="title-bar-text">Connect to OneNote</div>
      </div>
      <div class="window-body">
        <p>🔑 Paste a Microsoft Graph access token (Notes.ReadWrite).</p>
        <p class="hint">
          Your token is missing or expired. Tokens last about an hour; in dev, updating TOKEN in
          .env and restarting works too.
        </p>
        <form @submit.prevent="submit">
          <div class="field-row-stacked">
            <label for="token">Access token</label>
            <textarea id="token" v-model="value" rows="5" spellcheck="false" />
          </div>
          <section class="buttons">
            <button type="submit" class="default" :disabled="!value.trim()">Connect</button>
          </section>
        </form>
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
  z-index: 90;
  padding: 16px;
}

.token-dialog {
  width: min(420px, 100%);
}

.hint {
  color: #444;
}

textarea {
  font-family: monospace;
  word-break: break-all;
}

.buttons {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
</style>
