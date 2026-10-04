import LightningFS from '@isomorphic-git/lightning-fs'

import type { Notebook } from '@/graph/client'
import { createRepo } from './repo'
import type { MetaStore, SectionMeta } from './sync'

// Everything local lives in one IndexedDB-backed filesystem:
//   /repo   - the git repo with pages
//   /meta   - section page lists and notebooks as of the last sync, so the app works offline

const fs = new LightningFS('ntyonenote')
const META_DIR = '/meta'

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown) {
  try {
    await fs.promises.mkdir(META_DIR)
  } catch {
    // already there
  }
  await fs.promises.writeFile(path, JSON.stringify(value), 'utf8')
}

export const repo = createRepo(fs, '/repo')

export const meta: MetaStore = {
  load: (sectionId) => readJson<SectionMeta>(`${META_DIR}/${sectionId}.json`),
  save: (sectionId, value) => writeJson(`${META_DIR}/${sectionId}.json`, value),
}

export const notebooksCache = {
  load: () => readJson<Notebook[]>(`${META_DIR}/notebooks.json`),
  save: (notebooks: Notebook[]) => writeJson(`${META_DIR}/notebooks.json`, notebooks),
}
