import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { StraightDownExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

/** runs the executor's ticks on the bot's physics ticks until it's done or `max` ticks went by; the ticks it took */
async function runTicks (bot: any, tick: (n: number) => Promise<boolean | number>, max: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    let n = 0
    let busy = false
    const listener = (): void => {
      if (busy) return
      busy = true
      tick(n).then((done) => {
        busy = false
        n++
        if (done === true || n >= max) {
          bot.off('physicsTick', listener)
          resolve(n)
        }
      }, (err) => {
        bot.off('physicsTick', listener)
        reject(err)
      })
    }
    bot.on('physicsTick', listener)
  })
}

test('a StraightDown whose block is dug with the bot standing on the edge of the block beside the hole walks on to the middle and drops', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // the hole: (1, 63, 0) dug out of the floor already, a floor under it at y 62
    world.setBlock(new Vec3(1, 63, 0), 'air')
    world.setBlock(new Vec3(1, 62, 0), 'stone')
    // 0.204 off the middle along z: the box (0.3 to a side) over (1, 63, 1) by 0.004, which holds the bot up
    rig.bot.entity.position = new Vec3(1.5, 64, 0.7042)
    rig.bot.entity.velocity = new Vec3(0, 0, 0)
    rig.bot.entity.onGround = true
    rig.bot.clearControlStates()
    const move: any = { entryPos: new Vec3(1.5, 64, 0.5), exitPos: new Vec3(1.5, 63, 0.5), toPlace: [], toBreak: [BreakHandler.fromVec(new Vec3(1, 63, 0), 'solid')] }
    const executor = new StraightDownExecutor(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.defaultMoveSettings)
    executor.loadMove(move)
    const ticks = await runTicks(rig.bot, async (n) => await executor._performPerTick(move, n, 0, [move]), 60)
    const at = rig.bot.entity.position
    // it stood on the edge with no key held until the no-progress check failed the move
    assert.ok(ticks < 30, `${ticks} ticks, at ${at}`)
    assert.equal(at.y, 63, `at ${at}`)
  } finally {
    rig.stopPassivePhysics()
  }
})
