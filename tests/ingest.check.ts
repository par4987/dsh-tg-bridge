/** Inbound file ingestion: text detection, decoding, binary fallback. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, define, type Check } from './harness.ts'
import { decodeText, isTextLike, saveBinary } from '../src/ingest.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tg-bridge-ingest-'))

export const ingestChecks: Check[] = [
  define('isTextLike decides by mime first', () => {
    const bytes = Buffer.from('hola')
    assert(isTextLike('a.txt', 'text/plain', bytes), 'text/* is text')
    assert(isTextLike('a.json', 'application/json', bytes), 'json mime is text')
    assert(!isTextLike('a.jpg', 'image/jpeg', bytes), 'image mime is binary')
    assert(!isTextLike('a.zip', 'application/zip', bytes), 'zip mime is binary')
  }),

  define('isTextLike falls back to the extension', () => {
    assert(isTextLike('notas.md', '', Buffer.from('')), 'a markdown extension is text')
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])
    assert(!isTextLike('foto.png', '', pngBytes), 'a png extension with binary bytes is binary')
  }),

  define('isTextLike sniffs bytes when names and mimes say nothing', () => {
    assert(isTextLike('archivo', '', Buffer.from('plain words')), 'readable bytes are text')
    assert(!isTextLike('archivo', '', Buffer.concat([Buffer.from([0x00]), Buffer.from('x')])), 'a NUL byte means binary')
  }),

  define('decodeText handles the BOM variants', () => {
    assert(decodeText(Buffer.from('plain')) === 'plain', 'utf8 passes through')
    const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('sí', 'utf16le')])
    assert(decodeText(utf16le) === 'sí', 'utf16le decodes after its BOM')
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom')])
    assert(decodeText(utf8Bom) === 'bom', 'utf8 BOM is stripped')
  }),

  define('saveBinary sanitizes names and lands under the directory', () => {
    const path = saveBinary('informe final?.png', Buffer.from('x'), join(scratch, 'downloads'))
    assert(path.includes(join(scratch, 'downloads')), 'the file lands in the requested directory')
    assert(!/[?]/.test(path), 'unsafe characters are stripped')
    assert(readFileSync(path, 'utf-8') === 'x', 'the bytes round-trip')
    rmSync(scratch, { recursive: true, force: true })
  }),
]
