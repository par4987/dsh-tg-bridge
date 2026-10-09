/**
 * Structural bundle check for CI: the peers this bundle imports only exist
 * inside a dsh profile install, so the built artifact is verified without
 * importing it — rolldown keeps the export list at the file's tail, and the
 * loader reads exactly these named exports.
 */
const { readFileSync } = require('node:fs')

const source = readFileSync('lib/index.js', 'utf8')
const tail = source.slice(-4000)

for (const name of ['name', 'inject', 'Config', 'apply']) {
  if (!new RegExp(`\\b${name}\\b`).test(tail)) {
    throw new Error(`bundle is missing export: ${name}`)
  }
}
if (source.length < 10_000) {
  throw new Error('bundle is suspiciously small')
}
console.log('bundle exports ok')
