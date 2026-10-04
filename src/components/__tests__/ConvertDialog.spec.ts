import { describe, expect, it } from 'vitest'

import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ConvertDialog from '../ConvertDialog.vue'
import { useNotesStore } from '@/stores/notes'

describe('ConvertDialog', () => {
  it('shows where it is and stops on request', async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const notes = useNotesStore()
    notes.conversion = { from: 'Recipes', to: '_md Recipes', done: 3, total: 4, title: 'Soup' }
    const wrapper = mount(ConvertDialog, { global: { plugins: [pinia] } })

    expect(wrapper.text()).toContain('Soup')
    expect(wrapper.text()).toContain('From "Recipes" to "_md Recipes"')
    expect(wrapper.text()).toContain('Page 3 of 4')
    expect(wrapper.find('.progress-indicator-bar').attributes('style')).toContain('width: 50%')

    await wrapper.find('button').trigger('click')
    expect(notes.stopping).toBe(true)
    expect(wrapper.find('button').text()).toBe('Stopping...')
  })
})
