<script setup lang="ts">
import { computed } from 'vue'

// Win98-style 16x16 pixel icons, drawn as SVG so they stay crisp at any size.
// Each row is 16 characters, one per pixel; '.' is transparent, other characters are palette colors.

const ICONS = {
  folder: {
    palette: { O: '#4a3a00', L: '#fff3a0', Y: '#f0d060', D: '#b08a20' },
    rows: [
      '................',
      '................',
      '.OOOOO..........',
      'OLLLLLO.........',
      'OLYYYYLOOOOOOOO.',
      'OLYYYYYYYYYYYYYO',
      'OOOOOOOOOOOOOOOO',
      'OLLLLLLLLLLLLLYO',
      'OLYYYYYYYYYYYYDO',
      'OLYYYYYYYYYYYYDO',
      'OLYYYYYYYYYYYYDO',
      'OLYYYYYYYYYYYYDO',
      'OLYYYYYYYYYYYYDO',
      'ODDDDDDDDDDDDDDO',
      'OOOOOOOOOOOOOOOO',
      '................',
    ],
  },
  page: {
    palette: { O: '#202020', L: '#ffffff', G: '#a0a0a0' },
    rows: [
      '................',
      '...OOOOOOOO.....',
      '...OLLLLLLOO....',
      '...OLLLLLLOLO...',
      '...OLLLLLLOOOO..',
      '...OLLLLLLLLLO..',
      '...OLGGGGGGGLO..',
      '...OLLLLLLLLLO..',
      '...OLGGGGGGGLO..',
      '...OLLLLLLLLLO..',
      '...OLGGGGGGGLO..',
      '...OLLLLLLLLLO..',
      '...OLGGGGGLLLO..',
      '...OLLLLLLLLLO..',
      '...OOOOOOOOOOO..',
      '................',
    ],
  },
} satisfies Record<string, { palette: Record<string, string>; rows: string[] }>

export type PixelIconName = keyof typeof ICONS

const props = withDefaults(defineProps<{ name: PixelIconName; size?: number; muted?: boolean }>(), {
  size: 16,
  muted: false,
})

/** horizontal runs of one color, so a 16x16 icon is a few dozen rects, not 256 */
const runs = computed(() => {
  const { palette, rows } = ICONS[props.name]
  const result: { x: number; y: number; width: number; fill: string }[] = []
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const char = row[x]!
      let end = x + 1
      while (row[end] === char) end++
      const fill = (palette as Record<string, string>)[char]
      if (fill) result.push({ x, y, width: end - x, fill })
      x = end
    }
  })
  return result
})
</script>

<template>
  <svg
    class="pixel-icon"
    :class="{ muted }"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    shape-rendering="crispEdges"
    aria-hidden="true"
  >
    <rect v-for="(r, i) in runs" :key="i" :x="r.x" :y="r.y" :width="r.width" height="1" :fill="r.fill" />
  </svg>
</template>

<style scoped>
.pixel-icon {
  display: inline-block;
  vertical-align: text-bottom;
  flex-shrink: 0;
}

/* sections ntyonenote doesn't own yet: greyed out, like a disabled icon */
.muted {
  filter: grayscale(1);
  opacity: 0.6;
}
</style>
