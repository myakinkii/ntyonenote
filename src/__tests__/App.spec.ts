import { describe, it, expect, vi } from 'vitest'

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import App from '../App.vue'

// jsdom has no IndexedDB for lightning-fs; sync itself is covered in src/sync
vi.mock('@/sync/storage', () => ({
  repo: {
    init: async () => {},
    readFile: async () => null,
    pendingMerge: async () => null,
    files: async () => new Set(),
  },
  notebooksCache: { load: async () => null, save: async () => {} },
}))

describe('App', () => {
  it('starts offline without asking to sign in', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()

    expect(wrapper.find('.title-bar-text').text()).toContain('ntyonenote')
    expect(wrapper.text()).toContain('press Sync')
    expect(wrapper.text()).not.toContain('Connect to OneNote')
    expect(fetch).not.toHaveBeenCalled()
  })
})
