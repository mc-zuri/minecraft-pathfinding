import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Vec3 } from 'vec3'

import {
  DEFAULT_SETTLE_TICKS,
  handleSettledBlockEvent,
  waitForSettledBlockStateAtPosition,
  waitForSettledBlockUpdateAtPosition
} from '../src/customBlockEvents'

// a bot with a block at one position, whose ticks the test runs (physicsManual, a lockstep server)
function tickedBot (name: string): { bot: any, set: (name: string) => void, tick: (n?: number) => void } {
  const bot: any = new EventEmitter()
  const pos = new Vec3(1, 64, 1)
  let block: any = { name, type: name === 'air' ? 0 : 1, position: pos }
  bot.blockAt = (p: Vec3) => (p.floored().equals(pos) ? block : null)
  return {
    bot,
    set: (next: string) => {
      const old = block
      block = { name: next, type: next === 'air' ? 0 : 1, position: pos }
      bot.emit('blockUpdate', old, block)
    },
    tick: (n = 1) => { for (let i = 0; i < n; i++) bot.emit('physicsTick') }
  }
}

const isAir = (b: any): boolean => b?.name === 'air'
const wallClock = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))

test('a dug block settles after the bot\'s ticks for the server\'s answer, not after a time (DEFAULT_SETTLE_TICKS)', async () => {
  assert.equal(DEFAULT_SETTLE_TICKS, 2)
  const { bot, set, tick } = tickedBot('stone')
  let settled: any
  const wait = waitForSettledBlockStateAtPosition(bot, new Vec3(1, 64, 1), isAir, { timeoutMs: 5000 }).then((b) => { settled = b })
  set('air') // the client's prediction
  await wallClock(150) // twice the old 75 ms with no tick: still waiting for the server's tick
  assert.equal(settled, undefined)
  tick()
  await Promise.resolve()
  assert.equal(settled, undefined, 'settled after one tick')
  tick()
  await wait
  assert.equal((settled as any)?.name, 'air')
  assert.equal(bot.listenerCount('physicsTick'), 0)
  assert.equal(bot.listenerCount('blockUpdate'), 0)
})

test('ticks run back to back settle the block in two ticks, with no wall-clock wait', async () => {
  const { bot, set, tick } = tickedBot('stone')
  const start = performance.now()
  const wait = waitForSettledBlockStateAtPosition(bot, new Vec3(1, 64, 1), isAir, { timeoutMs: 5000 })
  set('air')
  tick(DEFAULT_SETTLE_TICKS)
  const block = await wait
  assert.equal(block?.name, 'air')
  assert.ok(performance.now() - start < 50, `took ${performance.now() - start} ms`)
})

test('the server putting the block back stops the settle, and its next prediction counts its ticks again', async () => {
  const { bot, set, tick } = tickedBot('stone')
  let settled: any
  const wait = waitForSettledBlockStateAtPosition(bot, new Vec3(1, 64, 1), isAir, { timeoutMs: 5000 }).then((b) => { settled = b })
  set('air')
  tick()
  set('stone') // the server's answer: the dig was refused
  tick(5)
  await Promise.resolve()
  assert.equal(settled, undefined)
  set('air')
  tick()
  await Promise.resolve()
  assert.equal(settled, undefined)
  tick()
  await wait
  assert.equal((settled as any)?.name, 'air')
})

test('an update at a position settles after its ticks, and a later update there starts them again', async () => {
  const { bot, set, tick } = tickedBot('stone')
  let settled: any
  const wait = waitForSettledBlockUpdateAtPosition(bot, new Vec3(1, 64, 1), { timeoutMs: 5000 }).then((b) => { settled = b })
  set('air')
  tick()
  set('dirt')
  tick()
  await Promise.resolve()
  assert.equal(settled, undefined)
  tick()
  await wait
  assert.equal((settled as any)?.name, 'dirt')
})

test('the pathfinder\'s settled block listener is called after the update\'s ticks', async () => {
  const { bot, set, tick } = tickedBot('stone')
  const calls: any[] = []
  const dispose = handleSettledBlockEvent(bot, (oldBlock, _newBlock, settledBlock) => { calls.push([oldBlock?.name, settledBlock?.name]) }, { settleTicks: DEFAULT_SETTLE_TICKS, timeoutMs: 250 })
  try {
    set('air')
    tick()
    await wallClock(100)
    assert.deepEqual(calls, [])
    tick()
    await wallClock(0)
    assert.deepEqual(calls, [['stone', 'air']])
  } finally {
    dispose()
  }
})
