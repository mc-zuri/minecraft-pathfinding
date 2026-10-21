import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { FALLING_WAIT_TICKS } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

// What a break may set off (Baritone's avoidBreaking and avoidAdjacentBreaking, re-implemented): no block is broken
// under a liquid or beside one (dontCreateFlow: any liquid, a source's or a flow's, waterlogged too), under sand or
// gravel, or beside sand or gravel with nothing under it (the break's update drops it); and a falling block in the
// cell or coming down into it is waited out before the dig.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

test('a block isn\'t broken under or beside a liquid, under sand, or beside sand or gravel with nothing under it; beside supported sand it is', async () => {
  const rig = createCacheWorld('1.21.11', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  const world = bot.world
  try {
    const cases: Array<[string, Array<[number, number, number, string]>, boolean]> = [
      ['alone', [], true],
      ['under water', [[0, 1, 0, 'water']], false],
      ['beside water', [[1, 0, 0, 'water']], false],
      ['under sand', [[0, 1, 0, 'sand']], false],
      ['beside sand over air', [[1, 0, 0, 'sand'], [1, -1, 0, 'air']], false],
      ['beside gravel over water', [[0, 0, 1, 'gravel'], [0, -1, 1, 'water']], false],
      ['beside sand on stone', [[1, 0, 0, 'sand'], [1, -1, 0, 'stone']], true]
    ]
    for (const [i, [what, around, breakable]] of cases.entries()) {
      // each case at its own spot in a block of stone (x 10 + 4i, y 70)
      const at = new Vec3(10 + 4 * i, 70, 0)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) world.setBlock(at.offset(dx, dy, dz), 'stone')
      for (const [dx, dy, dz, name] of around) world.setBlock(at.offset(dx, dy, dz), name)
      const movement = bot.pathfinder.movements.values().next().value
      const info = bot.pathfinder.world.getBlockInfo(at)
      assert.equal(movement.safeToBreak(info), breakable, what)
    }
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a dig waits while a falling block is in its cell\'s column over it, and goes on once it has landed', async () => {
  const rig = createCacheWorld('1.21.11', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  const world = bot.world
  try {
    // a corridor in bedrock along x at z 0, a stone at (2, 64, 0) in it: the way on is its dig
    for (let x = -2; x <= 5; x++) for (let z = -1; z <= 1; z++) for (let y = 64; y <= 66; y++) world.setBlock(new Vec3(x, y, z), 'bedrock')
    for (let x = 0; x <= 4; x++) for (const y of [64, 65]) world.setBlock(new Vec3(x, y, 0), x === 2 && y === 64 ? 'stone' : 'air')
    await bot.waitForTicks(4)
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    // a falling block over the stone's cell, for 30 ticks
    const falling = { id: 9999, name: 'falling_block', displayName: 'Falling Block', position: new Vec3(2.5, 66.2, 0.5), velocity: new Vec3(0, 0, 0) }
    bot.entities[falling.id] = falling
    let ticks = 0
    let digAt = -1
    const onTick = (): void => {
      ticks++
      if (ticks === 30) delete bot.entities[falling.id]
      if (digAt < 0 && bot.targetDigBlock != null) digAt = ticks
    }
    bot.on('physicsTick', onTick)
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(4, 64, 0)), 30000, `goto timed out at ${bot.entity.position}`)
    bot.off('physicsTick', onTick)
    assert.ok(digAt >= 30, `the dig started at tick ${digAt}, the falling block there till 30`)
    assert.ok(FALLING_WAIT_TICKS > 30)
  } finally {
    rig.stopPassivePhysics()
  }
})
