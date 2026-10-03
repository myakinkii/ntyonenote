import { describe, it, expect } from 'vitest'

import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import App from '../App.vue'

describe('App', () => {
  it('asks for a token when there is none', async () => {
    const wrapper = mount(App, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(wrapper.find('.title-bar-text').text()).toContain('ntyonenote')
    await flushPromises() // auth.init() is async now
    expect(wrapper.text()).toContain('Connect to OneNote')
  })
})
