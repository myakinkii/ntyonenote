/**
 * Microsoft sign-in: OAuth 2.0 auth code flow + PKCE, no client secret.
 * Web: SPA redirect back to this page, token calls via fetch (CORS allowed for SPA redirect URIs).
 * Native: system browser + custom-scheme redirect, token calls via CapacitorHttp
 * (native request has no Origin header, so Entra treats it as a mobile public client).
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core'
import { App } from '@capacitor/app'
import { Browser } from '@capacitor/browser'
import { Preferences } from '@capacitor/preferences'

const CLIENT_ID: string = import.meta.env.VITE_MS_CLIENT_ID
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0'
const SCOPES = 'Notes.ReadWrite User.Read offline_access'

const native = Capacitor.isNativePlatform()
// must match the redirect URIs in the app registration exactly
const REDIRECT_URI = native
  ? 'msauth.me.miakinkii.ntyonenote://auth'
  : window.location.origin + '/'

const KEYS = { refresh: 'ntyonenote.refresh', pending: 'ntyonenote.pending' }

let accessToken: string | null = null
let expiresAt = 0
let refreshing: Promise<string | null> | null = null

// --- PKCE helpers ---

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

// --- token endpoint ---

/** The token endpoint answered with an error: the refresh token is expired or revoked */
export class TokenRejectedError extends Error {}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  error?: string
  error_description?: string
}

async function tokenRequest(params: Record<string, string>): Promise<string> {
  const body = { client_id: CLIENT_ID, scope: SCOPES, ...params }
  const url = `${AUTHORITY}/token`
  let json: TokenResponse

  if (native) {
    const res = await CapacitorHttp.post({
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
    })
    json = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
  } else {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body) })
    json = await res.json()
  }

  if (json.error || !json.access_token) {
    throw new TokenRejectedError(json.error_description || json.error || 'Token request failed')
  }

  accessToken = json.access_token
  expiresAt = Date.now() + json.expires_in * 1000
  // Microsoft may rotate the refresh token, always keep the newest one
  if (json.refresh_token) await Preferences.set({ key: KEYS.refresh, value: json.refresh_token })
  return json.access_token
}

async function redeemCode(callbackUrl: string): Promise<void> {
  const params = new URL(callbackUrl).searchParams
  const { value } = await Preferences.get({ key: KEYS.pending })
  await Preferences.remove({ key: KEYS.pending })
  if (!value) throw new Error('No sign-in in progress')
  const pending = JSON.parse(value) as { state: string; verifier: string }

  if (params.get('error')) throw new Error(params.get('error_description') || params.get('error')!)
  if (params.get('state') !== pending.state) throw new Error('State mismatch, sign-in aborted')

  await tokenRequest({
    grant_type: 'authorization_code',
    code: params.get('code')!,
    redirect_uri: REDIRECT_URI,
    code_verifier: pending.verifier,
  })
}

// --- public API ---

/** Web: navigates away and resolves never. Native: resolves once tokens are stored. */
export async function signIn(): Promise<void> {
  const verifier = randomString()
  const state = randomString()
  await Preferences.set({ key: KEYS.pending, value: JSON.stringify({ state, verifier }) })

  const url = new URL(`${AUTHORITY}/authorize`)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()

  if (!native) {
    window.location.assign(url.toString())
    return new Promise(() => {})
  }

  const callback = await new Promise<string>((resolve, reject) => {
    const urlOpen = App.addListener('appUrlOpen', ({ url }) => {
      if (!url.startsWith(REDIRECT_URI)) return
      cleanup()
      resolve(url)
    })
    const closed = Browser.addListener('browserFinished', () => {
      cleanup()
      reject(new Error('Sign-in cancelled'))
    })
    function cleanup() {
      urlOpen.then((l) => l.remove())
      closed.then((l) => l.remove())
    }
    Browser.open({ url: url.toString() }).catch(reject)
  })

  await Browser.close().catch(() => {})
  await redeemCode(callback)
}

/** Web only: finishes a sign-in when the page loads with ?code=... */
export async function handleRedirect(): Promise<void> {
  if (native) return
  const here = new URL(window.location.href)
  if (!here.searchParams.has('code') && !here.searchParams.has('error')) return
  window.history.replaceState(null, '', here.pathname)
  await redeemCode(here.toString())
}

/**
 * Cached access token, refreshed when close to expiry. null means the user has to sign in.
 * Throws when the token endpoint can't be reached, being offline is not being signed out.
 */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken
  refreshing ??= (async () => {
    const { value } = await Preferences.get({ key: KEYS.refresh })
    if (!value) return null
    try {
      return await tokenRequest({ grant_type: 'refresh_token', refresh_token: value })
    } catch (e) {
      if (!(e instanceof TokenRejectedError)) throw e
      await signOut() // refresh token expired or revoked
      return null
    }
  })().finally(() => (refreshing = null))
  return refreshing
}

export async function signOut(): Promise<void> {
  accessToken = null
  expiresAt = 0
  await Preferences.remove({ key: KEYS.refresh })
}
