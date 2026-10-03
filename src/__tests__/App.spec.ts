import { describe, it, expect } from 'vitest'

import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import App from '../App.vue'

describe('App', () => {
  it('asks for a token when there is none', () => {
    const wrapper = mount(App, { global: { plugins: [createPinia()] } })
    expect(wrapper.find('.title-bar-text').text()).toContain('ntyonenote')
    expect(wrapper.text()).toContain('Connect to OneNote')
  })
})
