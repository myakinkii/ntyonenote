// ledger.json on main: the connector's metadata about sections and pages (docs/sync-design.md S3).

export const LEDGER_PATH = 'ledger.json'
const LOCAL_PREFIX = 'local-'

export interface LedgerSection {
  name: string
  notebook: string
  /** gone from the remote, kept locally until the user removes it (S7) */
  deleted?: true
}

export interface LedgerPage {
  section: string
  /** local title */
  title: string
  /** the page exists remotely */
  remote: boolean
  /** remote title as of the last fetch */
  remoteTitle?: string
  /** remote version as of the last listing */
  modified?: string
  /** remote version of the content on the remote branch */
  fetched?: string
  /** id it had before its first upload (S9.2) */
  createdAs?: string
  /** deleted locally, to be deleted remotely on push */
  deleted?: true
}

export interface Ledger {
  connector: string
  lastSync?: string
  sections: Record<string, LedgerSection>
  pages: Record<string, LedgerPage>
}

export const emptyLedger = (connector: string): Ledger => ({ connector, sections: {}, pages: {} })

export function parseLedger(text: string | null, connector: string): Ledger {
  return text ? (JSON.parse(text) as Ledger) : emptyLedger(connector)
}

/** Stable formatting: sorted keys, one entry per line block, so diffs stay readable */
export function serializeLedger(ledger: Ledger): string {
  const sorted = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
  return JSON.stringify({ ...ledger, sections: sorted(ledger.sections), pages: sorted(ledger.pages) }, null, 2) + '\n'
}

export const pagePath = (sectionId: string, pageId: string) => `${sectionId}/${pageId}.md`
export const newLocalId = () => LOCAL_PREFIX + crypto.randomUUID()

/** "<section>/<page>.md" -> { sectionId, pageId } */
export function parsePagePath(path: string) {
  const [sectionId = '', file = ''] = path.split('/')
  return { sectionId, pageId: file.replace(/\.md$/, '') }
}
