import { ref } from 'vue'
import { defineStore } from 'pinia'

import { createGraphClient } from '@/graph/client'

const STORAGE_KEY = 'ntyonenote.token'

function storedToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

// TODO: replace manual tokens with MSAL sign-in
export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(__DEV_GRAPH_TOKEN__ || storedToken())
  const needsToken = ref(!token.value)
  const userName = ref('')

  const graph = createGraphClient(() => token.value)

  function setToken(value: string) {
    token.value = value.trim().replace(/^Bearer\s+/i, '')
    needsToken.value = false
    try {
      localStorage.setItem(STORAGE_KEY, token.value)
    } catch {
      // storage unavailable, token lives in memory only
    }
  }

  function tokenRejected() {
    needsToken.value = true
  }

  async function loadUser() {
    const me = await graph.me()
    userName.value = me.displayName || me.userPrincipalName
  }

  return { token, needsToken, userName, graph, setToken, tokenRejected, loadUser }
})
