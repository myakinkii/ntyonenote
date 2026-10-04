import { ref } from 'vue'
import { defineStore } from 'pinia'

import * as oauth from '@/auth/oauth'
import { createGraphClient } from '@/graph/client'

const STORAGE_KEY = 'ntyonenote.token'
const USER_KEY = 'ntyonenote.user'

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // storage unavailable, keep it in memory only
  }
}

export const useAuthStore = defineStore('auth', () => {
  // manual token (Graph Explorer / .env) wins over MSAL sign-in, handy for dev
  const manualToken = ref<string | null>(__DEV_GRAPH_TOKEN__ || stored(STORAGE_KEY))
  /** shows the sign-in dialog; only ever set by an online action like Sync */
  const needsToken = ref(false)
  /** last known user, shown while offline too */
  const userName = ref(stored(USER_KEY) ?? '')
  const error = ref('')
  const canSignIn = !!import.meta.env.VITE_MS_CLIENT_ID

  async function getToken(): Promise<string | null> {
    if (manualToken.value) return manualToken.value
    const token = canSignIn ? await oauth.getAccessToken() : null
    if (!token) needsToken.value = true
    return token
  }

  const graph = createGraphClient(getToken)

  /**
   * Call once on startup. No network unless the page is coming back from a web sign-in;
   * resolves true then, so the sync that asked for it can carry on.
   */
  async function init(): Promise<boolean> {
    const params = new URL(window.location.href).searchParams
    if (!canSignIn || !(params.has('code') || params.has('error'))) return false
    try {
      await oauth.handleRedirect()
      return true
    } catch (e) {
      error.value = (e as Error).message
      needsToken.value = true
      return false
    }
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
    store(STORAGE_KEY, manualToken.value)
  }

  function clearManualToken() {
    manualToken.value = null
    store(STORAGE_KEY, null)
  }

  /** "Work offline": close the dialog, nothing else */
  function dismiss() {
    needsToken.value = false
  }

  async function signOut() {
    clearManualToken()
    await oauth.signOut()
    userName.value = ''
    store(USER_KEY, null)
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
    store(USER_KEY, userName.value)
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
    dismiss,
    signOut,
    tokenRejected,
    loadUser,
  }
})
