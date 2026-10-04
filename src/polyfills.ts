import { Buffer } from 'buffer'

// isomorphic-git expects Node's global Buffer
const global = globalThis as { Buffer?: typeof Buffer }
global.Buffer ??= Buffer
