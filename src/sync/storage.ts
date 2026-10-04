import LightningFS from '@isomorphic-git/lightning-fs'

import type { Notebook } from './connector'
import { createRepo } from './repo'

// Everything local lives in one IndexedDB-backed filesystem:
//   /repo   - the git repo: pages and ledger.json (docs/sync-design.md S2)
//   /meta   - the notebook tree as of the last sync, so the tree shows offline

const fs = new LightningFS('ntyonenote')
const META_DIR = '/meta'

export const repo = createRepo(fs, '/repo')

export const notebooksCache = {
  async load(): Promise<Notebook[] | null> {
    try {
      return JSON.parse(await fs.promises.readFile(`${META_DIR}/notebooks.json`, 'utf8'))
    } catch {
      return null
    }
  },
  async save(notebooks: Notebook[]) {
    try {
      await fs.promises.mkdir(META_DIR)
    } catch {
      // already there
    }
    await fs.promises.writeFile(`${META_DIR}/notebooks.json`, JSON.stringify(notebooks), 'utf8')
  },
}
