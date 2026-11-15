import test from 'node:test'
import assert from 'node:assert/strict'
import { readGuiReview, reviewContext } from '../index.js'

test('GUI selection and prompt are validated as one snapshot', () => {
  assert.deepEqual(readGuiReview({ provider: ' p ', model: ' m ', prompt: 'custom\n' }), { provider: 'p', model: 'm', system: 'custom' })
  assert.throws(() => readGuiReview({ provider: 'p', model: '', prompt: 'x' }), /both/)
  assert.throws(() => readGuiReview({ provider: '', model: '', prompt: '  ' }), /prompt/)
  assert.deepEqual(readGuiReview({ provider: '', model: '', prompt: 'default' }), { provider: '', model: '', system: 'default' })
})

test('updated GUI values affect the next review without touching the original gate', async () => {
  let selection = { provider: 'a', model: 'one', prompt: 'first' }
  const requests = []
  const ctx = { llm: { stream: async function* (request) { requests.push(request) } } }
  const wrapped = reviewContext(ctx, () => readGuiReview(selection))
  const source = { purpose: 'auto-review', provider: 'main', model: 'main', messages: [] }
  await Array.fromAsync(wrapped.llm.stream(source))
  selection = { provider: 'b', model: 'two', prompt: 'second' }
  await Array.fromAsync(wrapped.llm.stream(source))
  assert.deepEqual(requests.map(({ provider, model, system }) => ({ provider, model, system })), [
    { provider: 'a', model: 'one', system: 'first' }, { provider: 'b', model: 'two', system: 'second' },
  ])
})
