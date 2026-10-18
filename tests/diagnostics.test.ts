import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { RingBuffer } from '../src/diagnostics/ringBuffer'
import { PredictionCheck, classifyMismatch, controlsString, type MismatchEvidence } from '../src/diagnostics/predictionCheck'
import { blocksAround, diffCacheWithWorld, describeBlock } from '../src/diagnostics/pathState'
import { BlockInfo } from '../src/mineflayer-specific/world/cacheWorld'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

async function ticks (bot: any, n: number): Promise<void> {
  await withTimeout(new Promise<void>((resolve) => {
    let left = n
    const onTick = (): void => {
      if (--left > 0) return
      bot.off('physicsTick', onTick)
      resolve()
    }
    bot.on('physicsTick', onTick)
  }), n * 50 + 5000, `${n} ticks didn't pass`)
}

test('RingBuffer keeps the last items, oldest first', () => {
  const ring = new RingBuffer<number>(3)
  assert.deepEqual(ring.toArray(), [])
  assert.equal(ring.last(), undefined)
  ring.push(1)
  ring.push(2)
  assert.deepEqual(ring.toArray(), [1, 2])
  ring.push(3)
  ring.push(4)
  ring.push(5)
  assert.deepEqual(ring.toArray(), [3, 4, 5])
  assert.equal(ring.size, 3)
  assert.equal(ring.last(), 5)
  assert.equal(ring.last(2), 3)
  assert.equal(ring.last(3), undefined)
  ring.clear()
  assert.equal(ring.size, 0)
  assert.throws(() => new RingBuffer(0))
})

test('classifyMismatch takes the packets first, then the blocks changed, then the cache, then entities', () => {
  const none: MismatchEvidence = { forcedMove: false, velocityPacket: false, explosion: false, changedBlocks: [], matchesWithChanges: null, matchesBotWorld: null, entitiesNear: 0 }
  assert.equal(classifyMismatch(none), 'unknown')
  assert.equal(classifyMismatch({ ...none, forcedMove: true, velocityPacket: true }), 'server_correction')
  assert.equal(classifyMismatch({ ...none, explosion: true, velocityPacket: true }), 'explosion')
  assert.equal(classifyMismatch({ ...none, velocityPacket: true }), 'velocity')
  assert.equal(classifyMismatch({ ...none, changedBlocks: [{ own: false }], matchesWithChanges: true }), 'block_change')
  assert.equal(classifyMismatch({ ...none, changedBlocks: [{ own: true }], matchesWithChanges: true }), 'own_block_change')
  assert.equal(classifyMismatch({ ...none, changedBlocks: [{ own: true }, { own: false }], matchesWithChanges: true }), 'block_change')
  // a change that doesn't explain it: the cache's
  assert.equal(classifyMismatch({ ...none, changedBlocks: [{ own: false }], matchesWithChanges: false, matchesBotWorld: true }), 'cache_stale')
  assert.equal(classifyMismatch({ ...none, matchesBotWorld: false, entitiesNear: 2 }), 'entity_push')
  assert.equal(controlsString({ forward: true, back: false, left: false, right: false, jump: true, sprint: true, sneak: false }), 'forward+jump+sprint')
})

test('diffCacheWithWorld lists the cached cells whose block the world no longer has', () => {
  const { world, cacheWorld, rig } = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0))
  rig.stopPassivePhysics()
  const stone = new Vec3(2, 64, 0)
  world.setBlock(stone, 'stone')
  // the cache reads one cell, and holds stone for the next one, air in the world (as a missed block update)
  cacheWorld.getBlockInfo(stone)
  const air = world.getBlock(new Vec3(3, 64, 0))
  cacheWorld.blockInfos.set('3:64:0', BlockInfo.fromBlock(world.getBlock(stone) as any))
  const diff = diffCacheWithWorld([stone, new Vec3(3, 64, 0), new Vec3(4, 64, 0)], cacheWorld, (pos) => world.getBlock(pos) as any)
  assert.equal(diff.cached, 2)
  assert.equal(diff.disagreements.length, 1)
  assert.deepEqual(diff.disagreements[0].pos, [3, 64, 0])
  assert.match(diff.disagreements[0].cache, /^stone#/)
  assert.equal(diff.disagreements[0].world, describeBlock(air as any))

  const around = blocksAround(new Vec3(2.5, 64, 0.5), 1, (pos) => world.getBlock(pos) as any, cacheWorld)
  assert.deepEqual(around.origin, [2, 64, 0])
  assert.equal(around.blocks.length + around.air + around.unloaded, 27)
  assert.ok(around.blocks.some((b) => b.at.join() === '0,0,0' && b.block.startsWith('stone')), JSON.stringify(around.blocks))
  assert.deepEqual(around.disagreements.map((d) => d.pos), [[3, 64, 0]])
})

test('the prediction check finds no mismatch on a clean walk and a jump, and classifies a correction and a stale world', async () => {
  const { rig, cacheWorld } = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0))
  const bot = rig.bot as any
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  let stale = false
  // the world the check predicts on: the cache, or (stale) one that holds the floor ahead of the bot as air
  const check = new PredictionCheck(bot, {
    world: () => stale
      ? { getBlock: (pos: Vec3) => (Math.floor(pos.y) === 63 ? null : cacheWorld.getBlock(pos)) as any }
      : cacheWorld
  })
  check.alwaysOn = true
  try {
    await ticks(bot, 3)
    void bot.look(-Math.PI / 2, 0, true)
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    await ticks(bot, 10)
    bot.setControlState('jump', true)
    await ticks(bot, 10)
    bot.setControlState('jump', false)
    await ticks(bot, 10)
    assert.ok(check.stats.checked >= 25, `checked ${check.stats.checked} ticks`)
    assert.deepEqual(check.mismatches.toArray().map((m) => m.cls), [])
    const samples = check.samples.toArray()
    assert.ok(samples.some((s) => s.controls === 'forward+jump+sprint'), 'the jump\'s keys are sampled')
    assert.ok(samples.every((s) => s.delta == null || s.delta < 1e-5))

    // the server moves the bot a third of a block (a relative teleport: the position packet, mineflayer's forcedMove)
    bot._client.emit('position', { x: 0.3, y: 0, z: 0, yaw: 0, pitch: 0, flags: 31, teleportId: 1 })
    await ticks(bot, 2)
    const correction = check.mismatches.toArray().find((m) => m.cls === 'server_correction')
    assert.ok(correction != null, JSON.stringify(check.mismatches.toArray()))
    assert.ok(Math.abs(correction.delta - 0.3) < 0.05, `delta ${correction.delta}`)
    assert.ok(check.events.toArray().some((e) => e.type === 'position_correction'))
    assert.equal(check.mismatchSinceClass, null, 'the next tick matched again')

    // the world the check predicts on has no floor: it says the bot falls, the bot walks on
    stale = true
    await ticks(bot, 2)
    const staleMismatch = check.mismatches.last()
    assert.equal(staleMismatch?.cls, 'cache_stale')
    assert.equal(check.mismatchSinceClass, 'cache_stale')
    stale = false
    await ticks(bot, 2)
    assert.equal(check.mismatchSince, null)
  } finally {
    bot.clearControlStates()
    check.detach()
    rig.stopPassivePhysics()
  }
})

test('the prediction check runs on the world as it was: a floor block taken from under the bot is a block_change', async () => {
  const { rig, world } = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0))
  const bot = rig.bot as any
  bot.loadPlugin(createPlugin())
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  const check = bot.pathfinder.diagnostics as PredictionCheck
  check.alwaysOn = true
  try {
    await ticks(bot, 5)
    // the floor under the bot goes (the bot stands in the middle of its block: nothing else holds it up)
    world.clearBlock(new Vec3(0, 63, 0))
    await ticks(bot, 2)
    const mismatch = check.mismatches.toArray().find((m) => m.cls === 'block_change')
    assert.ok(mismatch != null, JSON.stringify(check.mismatches.toArray()))
    assert.deepEqual(mismatch.changed?.map((c) => c.pos), [[0, 63, 0]])
    assert.equal(mismatch.predicted.onGround, true)
    assert.equal(mismatch.actual.onGround, false)
    assert.ok(check.events.toArray().some((e) => e.type === 'block_update' && e.to === 'air'))
  } finally {
    check.detach()
    rig.stopPassivePhysics()
  }
})

test('a goto on flat ground has the check on while it walks, with no mismatch, and off after', async () => {
  const { rig } = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0))
  const bot = rig.bot as any
  bot.loadPlugin(createPlugin())
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  const check = bot.pathfinder.diagnostics as PredictionCheck
  try {
    await ticks(bot, 2)
    assert.equal(check.enabled, false)
    let onWhileWalking = false
    const watch = (): void => { if (check.enabled) onWhileWalking = true }
    bot.on('physicsTick', watch)
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(8, 64, 3)), 20000, 'goto timed out')
    bot.off('physicsTick', watch)
    assert.ok(onWhileWalking)
    assert.equal(check.enabled, false)
    assert.ok(check.stats.checked >= 20, `checked ${check.stats.checked}`)
    assert.deepEqual(check.mismatches.toArray().map((m) => `${m.cls} at ${m.tick}`), [])
    const perTick = check.stats.ms / check.stats.ticks
    assert.ok(perTick < 5, `${perTick} ms a tick`)
  } finally {
    check.detach()
    rig.stopPassivePhysics()
  }
})
