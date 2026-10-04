import git, { Errors, type FsClient, type TreeEntry } from 'isomorphic-git'

// Local git store, see docs/sync-design.md (S2).
//
//   main          - ledger.json + <sectionId>/<pageId>.md, local edits
//   <connector>   - <sectionId>/<pageId>.md as last fetched from / sent to the remote

export const MAIN = 'main'
/** converter output, the merge base for converting again (docs/convert-design.md C4) */
export const IMPORT = 'import'
/** author of commits made by the user, sync commits are authored by the connector */
export const LOCAL_AUTHOR = 'ntyonenote'

export interface PromiseFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>
  mkdir(path: string): Promise<void>
  unlink(path: string): Promise<void>
}

/** a file change to commit: null content deletes the file */
export interface FileChange {
  path: string
  content: string | null
}

/** state of an unfinished merge, kept outside git like git's own MERGE_HEAD */
export interface PendingMerge {
  theirs: string
  conflicts: string[]
  /** the branch being merged, absent in merges started before it was recorded */
  branch?: string
}

export interface LogEntry {
  oid: string
  parents: string[]
  message: string
  author: string
  date: Date
}

const author = (name: string) => ({ name, email: `${name}@ntyonenote.local` })
const decoder = new TextDecoder()
const encoder = new TextEncoder()

export function createRepo(fs: FsClient & { promises: PromiseFs }, dir: string) {
  const base = { fs, dir }
  const mergeFile = `${dir}/.git/ntyonenote-merge.json`
  const head = (ref: string) => git.resolveRef({ ...base, ref })

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

  /** Creates the repo with an empty root commit, the merge base of main and every remote branch (S2.1) */
  async function init(remote: string) {
    if (!(await exists(`${dir}/.git/HEAD`))) {
      await mkdirp(dir)
      await git.init({ ...base, defaultBranch: MAIN })
      const tree = await git.writeTree({ ...base, tree: [] })
      await git.commit({ ...base, message: 'Initial commit', tree, parent: [], author: author(LOCAL_AUTHOR) })
    }
    try {
      await head(remote)
    } catch {
      const commits = await git.log({ ...base, ref: MAIN })
      await git.writeRef({ ...base, ref: `refs/heads/${remote}`, value: commits.at(-1)!.oid })
    }
  }

  // --- worktree (main) ---

  async function readFile(path: string): Promise<string | null> {
    try {
      return await fs.promises.readFile(`${dir}/${path}`, 'utf8')
    } catch {
      return null
    }
  }

  async function writeFile(path: string, content: string | null) {
    if (content === null) {
      try {
        await fs.promises.unlink(`${dir}/${path}`)
      } catch {
        // already gone
      }
      return
    }
    if (path.includes('/')) await mkdirp(`${dir}/${path.slice(0, path.lastIndexOf('/'))}`)
    await fs.promises.writeFile(`${dir}/${path}`, content, 'utf8')
  }

  async function stage(path: string) {
    if ((await readFile(path)) === null) await git.remove({ ...base, filepath: path })
    else await git.add({ ...base, filepath: path })
  }

  /** Writes and commits files on main; returns false when nothing changed */
  async function commitFiles(changes: FileChange[], message: string, by = LOCAL_AUTHOR): Promise<boolean> {
    let changed = false
    for (const { path, content } of changes) {
      await writeFile(path, content)
      if (content === (await readAt(MAIN, path))) continue
      changed = true
      await stage(path)
    }
    if (changed) await git.commit({ ...base, ref: `refs/heads/${MAIN}`, message, author: author(by) })
    return changed
  }

  // --- reading branches and commits ---

  async function blobAt(commit: string, path: string): Promise<string | null> {
    try {
      return (await git.readBlob({ ...base, oid: commit, filepath: path })).oid
    } catch (e) {
      if (e instanceof Errors.NotFoundError) return null
      throw e
    }
  }

  async function readAtCommit(commit: string, path: string): Promise<string | null> {
    try {
      return decoder.decode((await git.readBlob({ ...base, oid: commit, filepath: path })).blob)
    } catch (e) {
      if (e instanceof Errors.NotFoundError) return null
      throw e
    }
  }

  async function readAt(ref: string, path: string): Promise<string | null> {
    return readAtCommit(await head(ref), path)
  }

  /** Whether a file is the same on two branches */
  async function sameAt(refA: string, refB: string, path: string): Promise<boolean> {
    return (await blobAt(await head(refA), path)) === (await blobAt(await head(refB), path))
  }

  async function sectionsOf(ref: string): Promise<Map<string, TreeEntry[]>> {
    const { tree } = await git.readTree({ ...base, oid: await head(ref) })
    const sections = new Map<string, TreeEntry[]>()
    for (const entry of tree) {
      if (entry.type === 'tree') sections.set(entry.path, (await git.readTree({ ...base, oid: entry.oid })).tree)
    }
    return sections
  }

  /** Paths of all files below section folders on a branch */
  async function files(ref: string): Promise<Set<string>> {
    const paths = new Set<string>()
    for (const [section, entries] of await sectionsOf(ref)) {
      for (const entry of entries) paths.add(`${section}/${entry.path}`)
    }
    return paths
  }

  /** Commits file changes in section folders straight onto a branch, without touching the worktree */
  async function commitToBranch(ref: string, changes: FileChange[], message: string, by: string): Promise<boolean> {
    if (!changes.length) return false
    const sections = await sectionsOf(ref)
    for (const { path, content } of changes) {
      const [section = '', file = ''] = path.split('/')
      const entries = (sections.get(section) ?? []).filter((e) => e.path !== file)
      if (content !== null) {
        const oid = await git.writeBlob({ ...base, blob: encoder.encode(content) })
        entries.push({ mode: '100644', path: file, oid, type: 'blob' })
      }
      sections.set(section, entries)
    }
    const root: TreeEntry[] = []
    for (const [path, entries] of sections) {
      if (!entries.length) continue
      root.push({ mode: '040000', path, oid: await git.writeTree({ ...base, tree: entries }), type: 'tree' })
    }
    const tree = await git.writeTree({ ...base, tree: root })
    const parent = await head(ref)
    if ((await git.readCommit({ ...base, oid: parent })).commit.tree === tree) return false
    await git.commit({ ...base, ref: `refs/heads/${ref}`, tree, parent: [parent], message, author: author(by) })
    return true
  }

  /** main's first-parent line, newest first: local commits and the merges of each sync (S9) */
  async function log(): Promise<LogEntry[]> {
    const entries: LogEntry[] = []
    let oid: string | undefined = await head(MAIN)
    while (oid) {
      const { commit } = await git.readCommit({ ...base, oid })
      entries.push({
        oid,
        parents: commit.parent,
        message: commit.message.trim(),
        author: commit.author.name,
        date: new Date(commit.committer.timestamp * 1000),
      })
      oid = commit.parent[0]
    }
    return entries
  }

  // --- merging ---

  /** Commits the whole worktree (like `git add -A`) as a merge of main and `theirs` */
  async function commitMerge(theirs: string, message: string, by: string) {
    for (const [filepath, inHead, workdir, staged] of await git.statusMatrix({ ...base })) {
      if (inHead === 1 && workdir === 1 && staged === 1) continue
      await stage(filepath)
    }
    await git.commit({
      ...base,
      ref: `refs/heads/${MAIN}`,
      message,
      parent: [await head(MAIN), theirs],
      author: author(by),
    })
  }

  /**
   * Merges a remote branch into main, never fast-forward (S4.2). Clean merges update main and the
   * worktree; conflicts leave markers in the worktree and are returned as a pending merge.
   */
  async function merge(remote: string): Promise<PendingMerge | null> {
    try {
      await git.merge({
        ...base,
        ours: MAIN,
        theirs: remote,
        fastForward: false,
        abortOnConflict: false,
        message: `Merge ${remote}`,
        author: author(remote),
      })
    } catch (e) {
      if (!(e instanceof Errors.MergeConflictError)) throw e
      const pending: PendingMerge = { theirs: await head(remote), conflicts: e.data.filepaths, branch: remote }
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

  /** Commits the resolved worktree as the merge */
  async function completeMerge(pending: PendingMerge, remote: string) {
    await commitMerge(pending.theirs, `Merge ${pending.branch ?? remote} (conflicts resolved)`, LOCAL_AUTHOR)
    await fs.promises.unlink(mergeFile)
  }

  return {
    init,
    readFile,
    writeFile,
    commitFiles,
    commitToBranch,
    files,
    blobAt,
    readAt,
    readAtCommit,
    sameAt,
    log,
    merge,
    pendingMerge,
    completeMerge,
  }
}

export type Repo = ReturnType<typeof createRepo>
