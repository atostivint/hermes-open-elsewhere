// Inlines src/presence.js into src/plugin.src.js -> desktop/plugin.js. The runtime
// loader reads ONE plugin.js and rewrites only SDK/react specifiers, so a
// relative import would not resolve.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const presence = readFileSync(join(root, 'src/presence.js'), 'utf8')
const entry = readFileSync(join(root, 'src/plugin.src.js'), 'utf8')

const importLine = /^import \{[^}]*\} from '\.\/presence\.js'\n/m

if (!importLine.test(entry)) {
  throw new Error("plugin.src.js must import from './presence.js' on one line")
}

const inlined = presence.replace(/^export /gm, '')
const out = entry.replace(importLine, '') + `\n// ── inlined from src/presence.js ──\n${inlined}`

mkdirSync(join(root, 'desktop'), { recursive: true })
writeFileSync(join(root, 'desktop/plugin.js'), out)
console.log('wrote desktop/plugin.js')
