<script setup lang="ts">
import { ref } from 'vue'

import { useAuthStore } from '@/stores/auth'

const emit = defineEmits<{ connected: [] }>()

const auth = useAuthStore()
const busy = ref(false)
const value = ref('')

async function signIn() {
  busy.value = true
  await auth.signIn()
  busy.value = false
  if (!auth.needsToken) emit('connected')
}

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
        <template v-if="auth.canSignIn">
          <p>🔑 Sign in with your personal Microsoft account to open your notebooks.</p>
          <p v-if="auth.error" class="error">⚠️ {{ auth.error }}</p>
          <section class="buttons">
            <button class="default" :disabled="busy" @click="signIn">
              {{ busy ? 'Signing in...' : 'Sign in with Microsoft' }}
            </button>
          </section>
        </template>

        <details :open="!auth.canSignIn">
          <summary>Paste a Graph access token instead</summary>
          <p class="hint">
            Notes.ReadWrite token, e.g. from Graph Explorer. Tokens last about an hour; in dev,
            updating TOKEN in .env and restarting works too.
          </p>
          <form @submit.prevent="submit">
            <div class="field-row-stacked">
              <label for="token">Access token</label>
              <textarea id="token" v-model="value" rows="5" spellcheck="false" />
            </div>
            <section class="buttons">
              <button type="submit" :disabled="!value.trim()">Connect</button>
            </section>
          </form>
        </details>
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

.error {
  color: #a00;
}

details {
  margin-top: 12px;
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
