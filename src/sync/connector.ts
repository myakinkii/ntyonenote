// A remote that pages are synced with. OneNote is the first one; anything that can list,
// read and write pages with some per-page change marker (S3 ETags, ...) fits.

export interface Section {
  id: string
  displayName: string
}

export interface Notebook {
  id: string
  displayName: string
  sections: Section[]
}

export interface RemotePage {
  id: string
  title: string
  /** changes whenever the page changes remotely, e.g. lastModifiedDateTime or an ETag */
  version: string
}

export interface Connector {
  /** also the name of the git branch mirroring this remote */
  id: string
  notebooks(): Promise<Notebook[]>
  /** sections this app owns and syncs, others are only shown */
  isSyncable(section: Section): boolean
  /** all pages of a section, newest first */
  listPages(section: Section): Promise<RemotePage[]>
  /** false only when the remote is sure the page is gone */
  pageExists(pageId: string): Promise<boolean>
  readPage(page: RemotePage): Promise<string>
  /** markdown exactly as the remote will store it, applied before anything is committed or sent */
  normalize(markdown: string): string
  writePage(page: RemotePage, markdown: string): Promise<void>
  createPage(section: Section, title: string, markdown: string): Promise<RemotePage>
  renamePage(page: RemotePage, title: string): Promise<void>
  /** a page that is already gone counts as deleted */
  deletePage(page: RemotePage): Promise<void>
}
