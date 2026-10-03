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
  ) {
    super(message)
  }
}

export type TokenProvider = () => Promise<string | null>

export function isMdSection(section: Section): boolean {
  return section.displayName.startsWith(MD_SECTION_PREFIX)
}

export function createGraphClient(getToken: TokenProvider) {
  async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = await getToken()
    if (!token) throw new GraphError(401, 'No access token')
    const res = await fetch(url.startsWith('http') ? url : BASE_URL + url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    })
    if (!res.ok) {
      let message = res.statusText
      try {
        message = (await res.json()).error?.message ?? message
      } catch {
        // not json, keep status text
      }
      throw new GraphError(res.status, message)
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

    async pages(section: Section): Promise<PageSummary[]> {
      const res = await getJson<{ value: PageSummary[] }>(
        `${section.pagesUrl}?$select=id,title,contentUrl,lastModifiedDateTime&$orderby=lastModifiedDateTime desc&$top=100`,
      )
      return res.value
    },

    async pageContent(page: PageSummary): Promise<MagicContent> {
      const res = await request(`${page.contentUrl}?includeIDs=true`)
      return extractMagicContent(await res.text())
    },

    /** Saves markdown, returns fresh magic content (paragraph id changes on every replace) */
    async savePageContent(page: PageSummary, markdown: string): Promise<MagicContent> {
      // id may be stale if someone saved meanwhile, so always look it up right before patching
      const current = await this.pageContent(page)
      const command = current.id
        ? { target: current.id, action: 'replace', content: encodeMagicParagraph(markdown) }
        : { target: 'body', action: 'append', content: encodeMagicParagraph(markdown) }
      await request(page.contentUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([command]),
      })
      return this.pageContent(page)
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

    async deletePage(page: PageSummary): Promise<void> {
      await request(`/me/onenote/pages/${page.id}`, { method: 'DELETE' })
    },
  }
}

export type GraphClient = ReturnType<typeof createGraphClient>
