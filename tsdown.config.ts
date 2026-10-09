/**
 * Build shape for the bundle plugin: one ESM entry that inlines every local
 * module and leaves the @deepseek-ai peers external — the installing profile
 * supplies them, so the loaded code is the profile's own generation.
 *
 * No `dts`: `prepare` runs on the installing machine, where the harness
 * sources the plugin typechecks against locally are absent.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  exports: false,
  clean: true,
  // The manifest points at lib/index.js; keep the ESM output on that name
  // instead of tsdown's default .mjs.
  outExtensions: () => ({ js: '.js' }),
})
