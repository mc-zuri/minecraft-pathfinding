import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A swimmer at the surface whose move out of the water digs first: a ForwardJump onto the shore through the stone on
// it (its start, performInit, digs before the jump). The start let go of the keys for the dig, and the runner held no
// jump while a start was under way (holdJumpInLiquid ran after the align's and the perform's ticks only): the bot sank
// under its dig, the crosshair went off the stone onto the one under it at each try, and 'no dig of the stone held the
// crosshair' failed the move again and again, the bot drowning under it (f9-1.21.11 t85654: from y 61.5 down to 58.4,
// pitch 1.47, the crosshair on the stone at (-547, 62, 52) under the dig's (-547, 63, 52)).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a swimmer whose move out onto the shore digs the stone on it first keeps at the surface while it digs (the runner holds jump through the move's start), and gets out (f9-1.21.11: 'no dig of the stone held the crosshair')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    const bot: any = rig.bot
    const Item = require('prismarine-item')(version)
    const pickaxe = new Item(rig.mcData.itemsByName.iron_pickaxe.id, 1)
    pickaxe.slot = 36
    bot.inventory.slots[36] = pickaxe
    bot.updateHeldItem()
    bot.loadPlugin(createPlugin())
    // a sea up to the cell at y 62 (x -8 to 8), the shore from x 9: stone up to y 63, and a row of stone over it at y 64
    // (x 9), the only way onto the shore through one of its blocks
    for (let x = -8; x <= 14; x++) {
      for (let z = -8; z <= 8; z++) {
        for (let y = 53; y <= 66; y++) {
          const name = x <= 8 ? (y === 53 ? 'stone' : y <= 62 ? 'water' : 'air') : (y <= 63 || (x === 9 && y === 64) ? 'stone' : 'air')
          bot.world.setBlock(new Vec3(x, y, z), name)
        }
      }
    }
    await bot.waitForTicks(4)
    const failed: string[] = []
    bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
    let lowest = Infinity
    const watch = (): void => { if (bot.pathfinder.isPathing === true) lowest = Math.min(lowest, bot.entity.position.y) }
    bot.on('physicsTick', watch)
    try {
      bot.entity.position = new Vec3(7.5, 62.2, 0.5)
      bot.entity.velocity = new Vec3(0, 0, 0)
      const goal = new goals.GoalBlock(9, 64, 0)
      await withTimeout(bot.pathfinder.goto(goal), 40000, `goto timed out at ${bot.entity.position} (${failed.join(' | ')})`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed, [])
      assert.equal(bot.blockAt(new Vec3(9, 64, 0)).name, 'air')
      // (the bot bobs at the surface, its feet never a block under the water's top cell; it sank to 58 under the dig)
      assert.ok(lowest > 61, `sank to ${lowest}`)
    } finally {
      bot.off('physicsTick', watch)
      rig.stopPassivePhysics()
    }
  })
}
