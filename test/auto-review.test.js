import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { reviewContext, loadReviewSettings } from '../index.js'

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-review-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('load explicit route and editable prompt', async t => {
  const dir = await fixture(t)
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ provider: ' other ', model: ' model ', promptFile: 'policy.txt' }))
  await writeFile(path.join(dir, 'policy.txt'), 'custom policy\n')
  assert.deepEqual(await loadReviewSettings(dir), { provider: 'other', model: 'model', system: 'custom policy' })
  await writeFile(path.join(dir, 'policy.txt'), 'changed')
  assert.equal((await loadReviewSettings(dir)).system, 'changed')
})

test('reject incomplete route and empty prompt', async t => {
  const dir = await fixture(t)
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ provider: 'a', model: '', promptFile: 'policy.txt' }))
  await assert.rejects(loadReviewSettings(dir), /both/)
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ provider: '', model: '', promptFile: 'policy.txt' }))
  await writeFile(path.join(dir, 'policy.txt'), ' \n')
  await assert.rejects(loadReviewSettings(dir), /empty/)
})

test('original review context uses a separate route and leaves source request intact', async () => {
  const dispatched = []
  const ctx = { llm: { stream: async function* (request) { dispatched.push(request); yield { type: 'finish' } } } }
  const proxy = reviewContext(ctx, async () => ({ provider: 'review-provider', model: 'review-model', system: 'custom' }))
  const review = Object.freeze({ purpose: 'auto-review', provider: 'p', model: 'm', system: 'old', messages: [] })
  assert.deepEqual(await Array.fromAsync(proxy.llm.stream(review)), [{ type: 'finish' }])
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].provider, 'review-provider')
  assert.equal(dispatched[0].model, 'review-model')
  assert.equal(dispatched[0].system, 'custom')
  assert.equal(review.system, 'old')
})

test('configuration failure prevents dispatch', async () => {
  let dispatched = false
  const ctx = { llm: { stream: async function* () { dispatched = true } } }
  const proxy = reviewContext(ctx, async () => { throw new Error('invalid policy') })
  await assert.rejects(Array.fromAsync(proxy.llm.stream({})), /invalid policy/)
  assert.equal(dispatched, false)
})
