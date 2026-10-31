/**
 * Version identity for the plugin. Kept in a module so tests and diagnostics
 * can assert it without importing package.json (which would be an import
 * attribute and a packaging concern).
 *
 * `scripts/pack-check.mjs` verifies this value equals package.json version.
 * @module dsh-tokeneconomizer/version
 */

/** Semver of this plugin package. */
export const VERSION = '0.1.0'

/** Schema version of the on-disk state written by this plugin. */
export const STATE_SCHEMA_VERSION = 1
