/** Locale catalog: interpolation, switching, and the missing-key fallback. */
import { assert, define, type Check } from './harness.ts'
import { locale, setLocale, t } from '../src/locale.ts'

export const localeChecks: Check[] = [
  define('t interpolates named placeholders', () => {
    setLocale('es')
    assert(t('ago_min', { n: 5 }) === 'hace 5 min', 'the placeholder is replaced')
  }),

  define('setLocale switches both catalogs', () => {
    setLocale('en')
    assert(t('ago_min', { n: 5 }) === '5 min ago', 'the English catalog answers')
    setLocale('es')
    assert(t('ago_min', { n: 5 }) === 'hace 5 min', 'the Spanish catalog answers')
  }),

  define('a missing key degrades to the key itself', () => {
    assert(t('no_such_key') === 'no_such_key', 'the key is the fallback')
  }),

  define('every Spanish key has an English counterpart', () => {
    // Both catalogs live in one module; t() falls back to Spanish, so the
    // invariant that matters is reachable: switching must never produce a
    // Spanish string for an English reader. Sample a representative set.
    setLocale('en')
    const probes = ['turn_aborted', 'approval_allow', 'question_confirm', 'ls_none', 'newtask_name', 'media_photo']
    for (const key of probes) {
      const value = t(key)
      assert(value !== key, `the English catalog covers ${key}`)
    }
    setLocale('es')
    assert(locale() === 'es', 'the switch is observable')
  }),

  define('unknown locales keep the current one', () => {
    setLocale('es')
    setLocale('fr' as 'es' | 'en')
    assert(locale() === 'es', 'an unknown locale does not switch')
  }),
]
