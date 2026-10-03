import { ref } from 'vue'
import { defineStore } from 'pinia'

export interface DialogButton<T extends string = string> {
  label: string
  value: T
}

export interface DialogRequest {
  title: string
  message: string
  icon: 'question' | 'warning' | 'error' | 'info'
  buttons: DialogButton[]
  /** present for prompts, holds the text field value */
  input?: { value: string }
  resolve: (value: string) => void
}

/** Win98-style message boxes: `await dialog.ask(...)` resolves with the clicked button value */
export const useDialogStore = defineStore('dialog', () => {
  const current = ref<DialogRequest | null>(null)

  function ask<T extends string>(
    title: string,
    message: string,
    buttons: DialogButton<T>[],
    icon: DialogRequest['icon'] = 'question',
  ): Promise<T> {
    return new Promise((resolve) => {
      current.value = {
        title,
        message,
        icon,
        buttons,
        resolve: (value) => {
          current.value = null
          resolve(value as T)
        },
      }
    })
  }

  function error(title: string, message: string) {
    return ask(title, message, [{ label: 'OK', value: 'ok' }], 'error')
  }

  /** Text prompt, resolves with the entered text or null when cancelled */
  function prompt(title: string, message: string, initial = ''): Promise<string | null> {
    const input = { value: initial }
    return new Promise((resolve) => {
      current.value = {
        title,
        message,
        icon: 'question',
        buttons: [
          { label: 'OK', value: 'ok' },
          { label: 'Cancel', value: 'cancel' },
        ],
        input,
        resolve: (value) => {
          current.value = null
          resolve(value === 'ok' ? input.value : null)
        },
      }
    })
  }

  return { current, ask, error, prompt }
})
