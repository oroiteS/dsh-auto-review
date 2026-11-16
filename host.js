import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { apply as applyReview, inject, name, readGuiReview } from './index.js'

const directory = path.dirname(fileURLToPath(import.meta.url))
const installDir = process.env.DSH_INSTALL_DIR ?? (process.resourcesPath
  ? path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh')
  : undefined)
if (!installDir) throw new Error('auto-review: cannot locate the DSH installation')
const requireFromDsh = createRequire(path.join(installDir, 'package.json'))
const z = requireFromDsh('@deepseek-ai/schemastery')

// Existing local settings become the initial GUI values, without rewriting them.
let initialReview = { provider: '', model: '', prompt: '', reasoningEffort: '' }
try {
  const legacy = JSON.parse(readFileSync(path.join(directory, 'config.json'), 'utf8'))
  if (typeof legacy.provider !== 'string' || typeof legacy.model !== 'string' || typeof legacy.promptFile !== 'string'
    || Boolean(legacy.provider.trim()) !== Boolean(legacy.model.trim()) || !legacy.promptFile.trim()) throw new Error('invalid configuration')
  const prompt = readFileSync(path.resolve(directory, legacy.promptFile), 'utf8').trimEnd()
  if (!prompt.trim()) throw new Error('empty prompt')
  const initial = {
    provider: legacy.provider.trim(), model: legacy.model.trim(), prompt,
    reasoningEffort: legacy.reasoningEffort === undefined ? '' : legacy.reasoningEffort,
  }
  readGuiReview(initial)
  initialReview = initial
} catch {
  // An existing GUI override still works. With no override, the empty prompt
  // fails closed and can be repaired in the configuration page.
  console.warn('[configurable-auto-review] legacy settings unavailable; review requires a valid GUI configuration')
}

export const Config = z.object({
  review: z.object({
    provider: z.string().required(),
    model: z.string().required(),
    prompt: z.string().required(),
    reasoningEffort: z.string().default(''),
  }).default(initialReview).volatile(),
})
export { inject, name }
export function apply(ctx, config) {
  return applyReview(ctx, () => readGuiReview(config.review.get()))
}
