// Integration with the actual DSH runtime; run under the application's Electron.
import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { reviewContext, readGuiReview } from '../index.js'

const available = Boolean(process.versions.electron && process.env.DSH_INSTALL_DIR)
const test = available ? nodeTest : nodeTest.skip

test('old GUI config receives the model-default effort without migration', async () => {
  const { Config } = await import('../host.js')
  const resolved = Config({ review: { provider: 'p', model: 'm', prompt: 'policy' } }).review.get()
  assert.equal(resolved.reasoningEffort, '')
  assert.deepEqual(readGuiReview(resolved), { provider: 'p', model: 'm', system: 'policy' })
})

test('actual DSH streaming resolves default and rejects unsupported reviewer effort', async () => {
  const requireFromDsh = createRequire(path.join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const { Context } = requireFromDsh('@deepseek-ai/cordis')
  const { LlmRuntime, LlmAdapter } = requireFromDsh('@deepseek-ai/dsh-llm')
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const dispatched = []
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
      } }
    }
    async *stream(options) {
      dispatched.push(options)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  llm.registerAdapter(['review'], new Adapter())
  let reasoningEffort = ''
  const wrapped = reviewContext({ llm }, () => readGuiReview({ provider: 'review', model: 'm', prompt: 'policy', reasoningEffort }))
  const source = Object.freeze({ purpose: 'auto-review', provider: 'original', model: 'original', reasoningEffort: 'high', messages: [] })
  const use = async () => Array.fromAsync(wrapped.llm.stream(source))
  assert.equal((await use())[0].reason.kind, 'stop')
  assert.equal(dispatched[0].reasoningEffort, 'low')
  reasoningEffort = 'high'
  assert.equal((await use())[0].reason.kind, 'stop')
  assert.equal(dispatched[1].reasoningEffort, 'high')
  reasoningEffort = 'not-supported'
  const failure = (await use())[0]
  assert.equal(failure.reason.kind, 'error')
  assert.equal(failure.reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(dispatched.length, 2)
  assert.equal(source.reasoningEffort, 'high')
})
