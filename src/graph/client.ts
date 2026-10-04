import { encodeMagicParagraph, extractMagicContent, type MagicContent } from './codec'

const BASE_URL = 'https://graph.microsoft.com/v1.0'

/** Only sections with this prefix are owned by ntyonenote */
export const MD_SECTION_PREFIX = '_md'

export interface Section {
  id: string
  displayName: string
  pagesUrl: string
}

export interface Notebook {
  id: string
  displayName: string
  sections: Section[]
}

export interface PageSummary {
  id: string
  title: string
  contentUrl: string
  lastModifiedDateTime: string
}

export class GraphError extends Error {
  constructor(
    public status: number,
    message: string,
    /** seconds to wait before retrying, from a 429's Retry-After */
    public retryAfter?: number,
  ) {
    super(message)
  }
}

/** OneNote (or the sign-in service) could not be reached */
export class OfflineError extends Error {
  constructor() {
    super("Can't reach OneNote, you seem to be offline.")
  }
}

export type TokenProvider = () => Promise<string | null>

export function isMdSection(section: { displayName: string }): boolean {
  return section.displayName.startsWith(MD_SECTION_PREFIX)
}

export function createGraphClient(getToken: TokenProvider) {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    let token: string | null
    let res: Response
    try {
      token = await getToken()
    } catch {
      throw new OfflineError()
    }
    if (!token) throw new GraphError(401, 'No access token')
    try {
      res = await fetch(url.startsWith('http') ? url : BASE_URL + url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
      })
    } catch {
      throw new OfflineError()
    }
    if (!res.ok) {
      let message = res.statusText
      try {
        message = (await res.json()).error?.message ?? message
      } catch {
        // not json, keep status text
      }
      throw new GraphError(res.status, message, Number(res.headers.get('Retry-After')) || undefined)
    }
    return res
  }

  const getJson = async <T>(url: string): Promise<T> => (await request(url)).json()

  return {
    async me(): Promise<{ displayName: string; userPrincipalName: string }> {
      return getJson('/me?$select=displayName,userPrincipalName')
    },

    async notebooks(): Promise<Notebook[]> {
      const select = '$select=id,displayName'
      const res = await getJson<{ value: Notebook[] }>(
        `/me/onenote/notebooks?${select}&$expand=sections($select=id,displayName,pagesUrl)&$orderby=displayName`,
      )
      return res.value
    },

    /** All pages of a section, following OData paging; by title, so version-stamped titles come newest first */
    async pages(section: Section): Promise<PageSummary[]> {
      const pages: PageSummary[] = []
      let url: string | undefined =
        `${section.pagesUrl}?$select=id,title,contentUrl,lastModifiedDateTime&$orderby=title desc&$top=100`
      while (url) {
        const res: { value: PageSummary[]; '@odata.nextLink'?: string } = await getJson(url)
        pages.push(...res.value)
        url = res['@odata.nextLink']
      }
      return pages
    },

    /** false only when OneNote says 404, listings can lag behind */
    async pageExists(pageId: string): Promise<boolean> {
      try {
        await request(`/me/onenote/pages/${pageId}?$select=id`)
        return true
      } catch (e) {
        if (e instanceof GraphError && e.status === 404) return false
        throw e
      }
    },

    async pageContent(page: PageSummary): Promise<MagicContent> {
      const res = await request(`${page.contentUrl}?includeIDs=true`)
      return extractMagicContent(await res.text())
    },

    /**
     * Replaces the page's markdown (the magic paragraph id changes on every replace),
     * optionally setting the title in the same request
     */
    async savePageContent(page: PageSummary, markdown: string, title?: string): Promise<void> {
      // id may be stale if someone saved meanwhile, so always look it up right before patching
      const current = await this.pageContent(page)
      const commands: object[] = [
        current.id
          ? { target: current.id, action: 'replace', content: encodeMagicParagraph(markdown) }
          : { target: 'body', action: 'append', content: encodeMagicParagraph(markdown) },
      ]
      if (title !== undefined) commands.push({ target: 'title', action: 'replace', content: title })
      await request(page.contentUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
      })
    },

    async renamePage(page: PageSummary, title: string): Promise<void> {
      await request(page.contentUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([{ target: 'title', action: 'replace', content: title }]),
      })
    },

    async createPage(section: Section, title: string, markdown = ''): Promise<PageSummary> {
      const escapedTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const html = `<!DOCTYPE html><html><head><title>${escapedTitle}</title></head><body>${encodeMagicParagraph(markdown)}</body></html>`
      const res = await request(section.pagesUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/html' },
        body: html,
      })
      const page = await res.json()
      return {
        id: page.id,
        title: page.title,
        contentUrl: page.contentUrl,
        lastModifiedDateTime: page.lastModifiedDateTime,
      }
    },

    // --- reading regular sections and creating _md mirrors (docs/convert-design.md) ---

    /** All pages of any section with their creation time, following OData paging */
    async sectionPages(sectionId: string): Promise<{ id: string; title: string; createdDateTime: string }[]> {
      const pages: { id: string; title: string; createdDateTime: string }[] = []
      let url: string | undefined = `/me/onenote/sections/${sectionId}/pages?$select=id,title,createdDateTime&$top=100`
      while (url) {
        const res: { value: typeof pages; '@odata.nextLink'?: string } = await getJson(url)
        pages.push(...res.value)
        url = res['@odata.nextLink']
      }
      return pages
    },

    /** A page's HTML as OneNote stores it, without element ids so unchanged pages read the same */
    async pageHtml(pageId: string): Promise<string> {
      return (await request(`/me/onenote/pages/${pageId}/content`)).text()
    },

    async createSection(notebookId: string, displayName: string): Promise<{ id: string; displayName: string }> {
      const res = await request(`/me/onenote/notebooks/${notebookId}/sections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName }),
      })
      const section = await res.json()
      return { id: section.id, displayName: section.displayName }
    },

    async deletePage(page: PageSummary): Promise<void> {
      await request(`/me/onenote/pages/${page.id}`, { method: 'DELETE' })
    },
  }
}

export type GraphClient = ReturnType<typeof createGraphClient>
