import { describe, it, expect, vi } from 'vitest'

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import App from '../App.vue'

// jsdom has no IndexedDB for lightning-fs; sync itself is covered in src/sync
vi.mock('@/sync/storage', () => ({
  repo: { init: async () => {}, pendingMerge: async () => null, unsynced: async () => [] },
  meta: { load: async () => null, save: async () => {} },
  notebooksCache: { load: async () => null, save: async () => {} },
}))

describe('App', () => {
  it('asks for a token when there is none', async () => {
    const wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find('.title-bar-text').text()).toContain('ntyonenote')
    await flushPromises() // auth.init() is async now
    expect(wrapper.text()).toContain('Connect to OneNote')
  })
})
