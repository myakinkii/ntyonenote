/// <reference types="vite/client" />

/** Graph access token from .env TOKEN, only defined when running the dev server */
declare const __DEV_GRAPH_TOKEN__: string

interface ImportMetaEnv {
  /** Application (client) ID of the Entra app registration */
  readonly VITE_MS_CLIENT_ID: string
}
