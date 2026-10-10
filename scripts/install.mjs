// Copies dist/plugin.js into $HERMES_HOME/desktop-plugins/open-elsewhere/.
// Usage: node scripts/install.mjs [hermesHome]   (default: $HERMES_HOME or ~/.hermes)
import { copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = process.argv[2] || process.env.HERMES_HOME || join(homedir(), '.hermes')
const dest = join(home, 'desktop-plugins', 'open-elsewhere')

mkdirSync(dest, { recursive: true })
copyFileSync(join(root, 'dist/plugin.js'), join(dest, 'plugin.js'))
console.log(`installed -> ${join(dest, 'plugin.js')}`)
