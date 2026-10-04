import git, { Errors, type FsClient, type TreeEntry } from 'isomorphic-git'

// Local git store for markdown pages.
//
//   main     - local edits, a commit per save
//   onenote  - mirror of what OneNote last returned ("remote without remote")
//
// Pages live in the main worktree as `<sectionId>/<pageId>.md`.

export const MAIN = 'main'
export const ONENOTE = 'onenote'

const AUTHOR = { name: 'ntyonenote', email: 'ntyonenote@localhost' }

export interface PromiseFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** a page change to commit: null content deletes the page */
export interface PageChange {
  path: string
  content: string | null
}

/** state of an unfinished merge, kept outside git like git's own MERGE_HEAD */
export interface PendingMerge {
  theirs: string
  conflicts: string[]
}

export function pagePath(sectionId: string, pageId: string): string {
  return `${sectionId}/${pageId}.md`
}

export function pageIdOf(path: string): string {
  return path.slice(path.indexOf('/') + 1).replace(/\.md$/, '')
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function createRepo(fs: FsClient & { promises: PromiseFs }, dir: string) {
  const base = { fs, dir }
  const mergeFile = `${dir}/.git/ntyonenote-merge.json`

  async function exists(path: string): Promise<boolean> {
    try {
      await fs.promises.readFile(path, 'utf8')
      return true
    } catch {
      return false
    }
  }

  async function mkdirp(path: string) {
    let current = ''
    for (const part of path.split('/').filter(Boolean)) {
      current += `/${part}`
      try {
        await fs.promises.mkdir(current)
      } catch {
        // already there
      }
    }
  }

  /** Creates the repo with a shared empty root commit, so both branches always have a merge base */
  async function init() {
    if (await exists(`${dir}/.git/HEAD`)) return
    await mkdirp(dir)
    await git.init({ ...base, defaultBranch: MAIN })
    const tree = await git.writeTree({ ...base, tree: [] })
    const root = await git.commit({ ...base, message: 'Initial commit', tree, parent: [], author: AUTHOR })
    await git.writeRef({ ...base, ref: `refs/heads/${ONENOTE}`, value: root })
  }

  async function readPage(path: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(`${dir}/${path}`, 'utf8')
    } catch {
      return null
    }
  }

  async function writePage(path: string, content: string) {
    await mkdirp(`${dir}/${path.slice(0, path.lastIndexOf('/'))}`)
    await fs.promises.writeFile(`${dir}/${path}`, content, 'utf8')
  }

  async function deletePage(path: string) {
    try {
      await fs.promises.unlink(`${dir}/${path}`)
    } catch {
      // already gone
    }
  }

  /** Commits worktree files to main; returns false when nothing changed */
  async function commitWorktree(paths: string[], message: string): Promise<boolean> {
    let changed = false
    for (const path of paths) {
      const content = await readPage(path)
      if (content === (await readAt(MAIN, path))) continue
      changed = true
      if (content === null) await git.remove({ ...base, filepath: path })
      else await git.add({ ...base, filepath: path })
    }
    if (changed) await git.commit({ ...base, ref: `refs/heads/${MAIN}`, message, author: AUTHOR })
    return changed
  }

  async function buildRoot(sections: Map<string, TreeEntry[]>): Promise<TreeEntry[]> {
    const root: TreeEntry[] = []
    for (const [path, entries] of sections) {
      if (!entries.length) continue
      const oid = await git.writeTree({ ...base, tree: entries })
      root.push({ mode: '040000', path, oid, type: 'tree' })
    }
    return root
  }

  async function sectionsOf(ref: string): Promise<Map<string, TreeEntry[]>> {
    const oid = await git.resolveRef({ ...base, ref })
    const { tree } = await git.readTree({ ...base, oid })
    const sections = new Map<string, TreeEntry[]>()
    for (const entry of tree) {
      if (entry.type !== 'tree') continue
      sections.set(entry.path, (await git.readTree({ ...base, oid: entry.oid })).tree)
    }
    return sections
  }

  /** Commits page changes straight onto a branch without touching the worktree */
  async function commitToBranch(ref: string, changes: PageChange[], message: string): Promise<boolean> {
    if (!changes.length) return false
    const sections = await sectionsOf(ref)
    for (const { path, content } of changes) {
      const [section, file] = path.split('/') as [string, string]
      const entries = (sections.get(section) ?? []).filter((e) => e.path !== file)
      if (content !== null) {
        const oid = await git.writeBlob({ ...base, blob: encoder.encode(content) })
        entries.push({ mode: '100644', path: file, oid, type: 'blob' })
      }
      sections.set(section, entries)
    }
    const tree = await git.writeTree({ ...base, tree: await buildRoot(sections) })
    const parent = await git.resolveRef({ ...base, ref })
    const { commit } = await git.readCommit({ ...base, oid: parent })
    if (commit.tree === tree) return false
    await git.commit({ ...base, ref: `refs/heads/${ref}`, tree, parent: [parent], message, author: AUTHOR })
    return true
  }

  /** page id -> blob oid of a section on a branch */
  async function sectionBlobs(ref: string, sectionId: string): Promise<Map<string, string>> {
    const entries = (await sectionsOf(ref)).get(sectionId) ?? []
    return new Map(entries.map((e) => [pageIdOf(`${sectionId}/${e.path}`), e.oid]))
  }

  async function readAt(ref: string, path: string): Promise<string | null> {
    try {
      const oid = await git.resolveRef({ ...base, ref })
      const { blob } = await git.readBlob({ ...base, oid, filepath: path })
      return decoder.decode(blob)
    } catch (e) {
      if (e instanceof Errors.NotFoundError) return null
      throw e
    }
  }

  /** Page ids whose main version differs from what OneNote has */
  async function unsynced(sectionId: string): Promise<string[]> {
    const [ours, theirs] = await Promise.all([sectionBlobs(MAIN, sectionId), sectionBlobs(ONENOTE, sectionId)])
    const ids = new Set([...ours.keys(), ...theirs.keys()])
    return [...ids].filter((id) => ours.get(id) !== theirs.get(id))
  }

  /**
   * Merges onenote into main. Clean merges update main and the worktree;
   * conflicts leave markers in the worktree and are returned as a pending merge.
   */
  async function mergeOneNote(): Promise<PendingMerge | null> {
    try {
      await git.merge({
        ...base,
        ours: MAIN,
        theirs: ONENOTE,
        abortOnConflict: false,
        message: 'Merge OneNote changes',
        author: AUTHOR,
      })
    } catch (e) {
      if (!(e instanceof Errors.MergeConflictError)) throw e
      const pending = {
        theirs: await git.resolveRef({ ...base, ref: ONENOTE }),
        conflicts: e.data.filepaths,
      }
      await fs.promises.writeFile(mergeFile, JSON.stringify(pending), 'utf8')
      return pending
    }
    // worktree holds only committed content here, so a forced checkout just catches it up
    await git.checkout({ ...base, ref: MAIN, force: true })
    return null
  }

  async function pendingMerge(): Promise<PendingMerge | null> {
    try {
      return JSON.parse(await fs.promises.readFile(mergeFile, 'utf8'))
    } catch {
      return null
    }
  }

  /** Commits the whole resolved worktree (like `git add -A`) as a merge of main and onenote */
  async function completeMerge(pending: PendingMerge) {
    for (const [filepath, head, workdir, stage] of await git.statusMatrix({ ...base })) {
      if (head === 1 && workdir === 1 && stage === 1) continue
      if (workdir === 0) await git.remove({ ...base, filepath })
      else await git.add({ ...base, filepath })
    }
    await git.commit({
      ...base,
      ref: `refs/heads/${MAIN}`,
      message: 'Merge OneNote changes',
      parent: [await git.resolveRef({ ...base, ref: MAIN }), pending.theirs],
      author: AUTHOR,
    })
    await fs.promises.unlink(mergeFile)
  }

  /** Commits that changed a page on main, newest first */
  async function history(path: string) {
    const commits = await git.log({ ...base, ref: MAIN, filepath: path, force: true })
    return commits.map(({ oid, commit }) => ({
      oid,
      message: commit.message.trim(),
      date: new Date(commit.committer.timestamp * 1000),
    }))
  }

  async function readAtCommit(oid: string, path: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ ...base, oid, filepath: path })
      return decoder.decode(blob)
    } catch (e) {
      if (e instanceof Errors.NotFoundError) return null
      throw e
    }
  }

  return {
    init,
    readPage,
    writePage,
    deletePage,
    commitWorktree,
    commitToBranch,
    sectionBlobs,
    readAt,
    unsynced,
    mergeOneNote,
    pendingMerge,
    completeMerge,
    history,
    readAtCommit,
  }
}

export type Repo = ReturnType<typeof createRepo>
