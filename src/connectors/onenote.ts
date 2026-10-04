import {
  GraphError,
  isMdSection,
  type GraphClient,
  type PageSummary,
  type Section as GraphSection,
} from '@/graph/client'
import type { Connector, RemotePage, Section } from '@/sync/connector'

const BASE_URL = 'https://graph.microsoft.com/v1.0/me/onenote'
// what the codec turns tabs into, see encodeMarkdown
const TAB_SPACES = '    '

const toGraphSection = (section: Section): GraphSection => ({
  ...section,
  pagesUrl: `${BASE_URL}/sections/${section.id}/pages`,
})

const toGraphPage = (page: RemotePage): PageSummary => ({
  id: page.id,
  title: page.title,
  contentUrl: `${BASE_URL}/pages/${page.id}/content`,
  lastModifiedDateTime: page.version,
})

// OneNote's lastModifiedDateTime doesn't move when a page is edited (docs/sync-design.md S10.4),
// so every write stamps the title with our own version: "#2026-10-04T13:38:08.123Z# Title".
// It leads the title, so OneNote's $orderby=title sorts stamped pages by version.
// The marker never leaves this file: the ledger and the UI only see the bare title.
const VERSION_MARKER = /^\s*#(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)#\s*/

/** Splits OneNote's title into the user's title and our version marker, if any */
export function splitTitle(raw: string): { title: string; version: string | null } {
  const match = VERSION_MARKER.exec(raw)
  return match
    ? { title: raw.slice(match[0].length), version: match[1]! }
    : { title: raw, version: null }
}

/** The title as stored in OneNote, with a fresh version marker */
export function stampTitle(title: string, version = new Date().toISOString()): string {
  return title ? `#${version}# ${title}` : `#${version}#`
}

const toRemotePage = (page: PageSummary): RemotePage => {
  const { title, version } = splitTitle(page.title)
  // pages never written by ntyonenote have no marker yet, fall back to OneNote's (stuck) timestamp
  return { id: page.id, title, version: version ?? page.lastModifiedDateTime }
}

export function createOneNoteConnector(graph: GraphClient): Connector {
  return {
    id: 'onenote',

    async notebooks() {
      return (await graph.notebooks()).map((notebook) => ({
        id: notebook.id,
        displayName: notebook.displayName,
        sections: notebook.sections.map(({ id, displayName }) => ({ id, displayName })),
      }))
    },

    isSyncable: isMdSection,

    async listPages(section) {
      // newest first by version: markers and fallback timestamps are both ISO strings
      return (await graph.pages(toGraphSection(section)))
        .map(toRemotePage)
        .sort((a, b) => b.version.localeCompare(a.version))
    },

    pageExists: (pageId) => graph.pageExists(pageId),

    async readPage(page) {
      return (await graph.pageContent(toGraphPage(page))).markdown
    },

    normalize: (markdown) => markdown.replace(/\r\n?/g, '\n').replace(/\t/g, TAB_SPACES),

    async writePage(page, markdown) {
      // page.title is the bare remote title, so this only bumps the marker, it doesn't rename
      await graph.savePageContent(toGraphPage(page), markdown, stampTitle(page.title))
    },

    async createPage(section, title, markdown) {
      return toRemotePage(
        await graph.createPage(toGraphSection(section), stampTitle(title), markdown),
      )
    },

    async renamePage(page, title) {
      await graph.renamePage(toGraphPage(page), stampTitle(title))
    },

    async deletePage(page) {
      try {
        await graph.deletePage(toGraphPage(page))
      } catch (e) {
        if (!(e instanceof GraphError && e.status === 404)) throw e
      }
    },
  }
}
