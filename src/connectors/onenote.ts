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

const toRemotePage = (page: PageSummary): RemotePage => ({
  id: page.id,
  title: page.title,
  version: page.lastModifiedDateTime,
})

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
      return (await graph.pages(toGraphSection(section))).map(toRemotePage)
    },

    pageExists: (pageId) => graph.pageExists(pageId),

    async readPage(page) {
      return (await graph.pageContent(toGraphPage(page))).markdown
    },

    normalize: (markdown) => markdown.replace(/\r\n?/g, '\n').replace(/\t/g, TAB_SPACES),

    async writePage(page, markdown) {
      await graph.savePageContent(toGraphPage(page), markdown)
    },

    async createPage(section, title, markdown) {
      return toRemotePage(await graph.createPage(toGraphSection(section), title, markdown))
    },

    async renamePage(page, title) {
      await graph.renamePage(toGraphPage(page), title)
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
