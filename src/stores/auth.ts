import { ref } from 'vue'
import { defineStore } from 'pinia'

import * as oauth from '@/auth/oauth'
import { createGraphClient } from '@/graph/client'

const STORAGE_KEY = 'ntyonenote.token'

function storedToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export const useAuthStore = defineStore('auth', () => {
  // manual token (Graph Explorer / .env) wins over MSAL sign-in, handy for dev
  const manualToken = ref<string | null>(__DEV_GRAPH_TOKEN__ || storedToken())
  const needsToken = ref(false)
  const userName = ref('')
  const error = ref('')
  const canSignIn = !!import.meta.env.VITE_MS_CLIENT_ID

  async function getToken(): Promise<string | null> {
    if (manualToken.value) return manualToken.value
    const token = canSignIn ? await oauth.getAccessToken() : null
    if (!token) needsToken.value = true
    return token
  }

  const graph = createGraphClient(getToken)

  /** call once on startup, before the first Graph request */
  async function init() {
    try {
      if (canSignIn) await oauth.handleRedirect()
    } catch (e) {
      error.value = (e as Error).message
    }
    needsToken.value = !(await getToken())
  }

  async function signIn() {
    error.value = ''
    try {
      await oauth.signIn()
      clearManualToken()
      needsToken.value = false
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  function setToken(value: string) {
    manualToken.value = value.trim().replace(/^Bearer\s+/i, '')
    needsToken.value = false
    try {
      localStorage.setItem(STORAGE_KEY, manualToken.value)
    } catch {
      // storage unavailable, token lives in memory only
    }
  }

  function clearManualToken() {
    manualToken.value = null
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // nothing stored
    }
  }

  async function signOut() {
    clearManualToken()
    await oauth.signOut()
    userName.value = ''
    needsToken.value = true
  }

  function tokenRejected() {
    // an expired pasted token shouldn't shadow a valid sign-in
    clearManualToken()
    needsToken.value = true
  }

  async function loadUser() {
    const me = await graph.me()
    userName.value = me.displayName || me.userPrincipalName
  }

  return {
    needsToken,
    userName,
    error,
    canSignIn,
    graph,
    init,
    signIn,
    setToken,
    signOut,
    tokenRejected,
    loadUser,
  }
})
