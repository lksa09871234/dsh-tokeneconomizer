/**
 * Cordis configuration schema for the plugin.
 *
 * Kept separate from `lib/config.js` on purpose: only the plugin entry (which
 * runs inside DSH, where the harness resolves its own packages) needs the
 * schemastery schema. The terminal CLI and every mechanism import
 * `lib/config.js`, which is dependency-free, so `node bin/te.js` also works from
 * a packed npm install where optional peer packages are not present.
 *
 * @module dsh-tokeneconomizer/config-schema
 */

import z from '@deepseek-ai/schemastery'

import {
  DEFAULTS,
  LOOPGUARD_MODES,
  MICROSKILLS_MODES,
  TOOLPRUNE_MODES,
} from './config.js'

/** Configuration schema used by the Cordis loader (schemastery). */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('Enable the plugin. Disabled keeps every mechanism inert.'),
  dataDir: z.string().default(DEFAULTS.dataDir).description('Absolute state directory. Empty means <DSH home>/tokeneconomizer.'),
  microskills: z.union(MICROSKILLS_MODES.map((mode) => z.const(mode))).default(DEFAULTS.microskills).description('Micro-skills: off, envfacts (no model calls), or on (adds the optional model proposer).'),
  toolprune: z.union(TOOLPRUNE_MODES.map((mode) => z.const(mode))).default(DEFAULTS.toolprune).description('Tool pruning: off, propose (default), or apply (hide pruned tools from the model for this project).'),
  loopguard: z.union(LOOPGUARD_MODES.map((mode) => z.const(mode))).default(DEFAULTS.loopguard).description('Failure-loop intervention: on (default) or off.'),
  microskillsProposeEvery: z.natural().min(1).default(DEFAULTS.microskillsProposeEvery).description('Sessions between runs of the optional model fact proposer (upstream k).'),
  microskillsMaxChars: z.natural().min(120).default(DEFAULTS.microskillsMaxChars).description('Maximum characters of learned notes injected per session.'),
  microskillsMaxFacts: z.natural().min(1).default(DEFAULTS.microskillsMaxFacts).description('Maximum facts injected per session.'),
  toolpruneEvidence: z.natural().min(1).default(DEFAULTS.toolpruneEvidence).description('Unused prompts required before a tool can be proposed for pruning (upstream p=10).'),
  toolpruneMinSessions: z.natural().min(1).default(DEFAULTS.toolpruneMinSessions).description('Sessions those unused prompts must span (upstream m=2).'),
  toolpruneSessions: z.natural().min(1).default(DEFAULTS.toolpruneSessions).description('Session count whose whole length counts as evidence (upstream s=5).'),
  toolpruneQuietMinutes: z.natural().default(DEFAULTS.toolpruneQuietMinutes).description('Idle minutes before a changed apply list takes effect (upstream q=60).'),
  protectedTools: z.array(z.string()).default(DEFAULTS.protectedTools).description('Tool names that are never proposed or applied for pruning.'),
  loopguardEnvelopeMinSamples: z.natural().min(1).default(DEFAULTS.loopguardEnvelopeMinSamples).description('Well-behaved turns observed before the loop guard acts (upstream e=5).'),
  loopguardJudgeConfidence: z.number().min(0).max(1).default(DEFAULTS.loopguardJudgeConfidence).description('Minimum optional-judge confidence to redirect (upstream c=0.7).'),
  loopguardNudges: z.natural().default(DEFAULTS.loopguardNudges).description('Redirects per turn after which the guard only reports (upstream r=1).'),
  loopguardBackstopMultiplier: z.number().min(1).default(DEFAULTS.loopguardBackstopMultiplier).description('Multiple of the usual turn length that permits a judge-free redirect (upstream b=2.5).'),
  loopguardJudgeMinIntervalMs: z.natural().min(0).default(DEFAULTS.loopguardJudgeMinIntervalMs).description('Minimum milliseconds between optional judge calls in one turn.'),
  loopguardJudge: z.boolean().default(DEFAULTS.loopguardJudge).description('Allow the optional model judge. Off means rule-only detection.'),
  usageRecord: z.boolean().default(DEFAULTS.usageRecord).description('Record actual token usage reported by the harness (never estimated savings).'),
  diagnosticsRecord: z.boolean().default(DEFAULTS.diagnosticsRecord).description('Record redacted diagnostics for plugin failures instead of throwing into the session.'),
  diagnostics: z.union([z.const('redacted'), z.const('off')]).default(DEFAULTS.diagnostics).description('Diagnostics verbosity; redacted never stores prompts, tool output, or credentials.'),
  diagnosticsMaxBytes: z.natural().min(1024).default(DEFAULTS.diagnosticsMaxBytes).description('Maximum bytes retained for the diagnostics file.'),
})
