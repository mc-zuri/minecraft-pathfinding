import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, digInSight } from '../src'
import { createCacheWorld } from './setup'

// The crosshair's look for a dig, as the server and the bot see it. The look is kept on the dig's point as the bot
// moves, as a player keeps the crosshair on the block with the mouse: a swimmer bobbing at the surface (its jump held)
// had the crosshair go off the block with its look left as it was, each dig started again from nothing, and 'no dig of
// the stone held the crosshair' (f9-1.21.11).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a swimmer bobbing at the surface digs the stone on the shore in one dig, its look kept on the block's point as it bobs (f9-1.21.11: 'no dig of the stone held the crosshair')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const Item = require('prismarine-item')(version)
    const pickaxe = new Item(rig.mcData.itemsByName.iron_pickaxe.id, 1)
    pickaxe.slot = 36
    bot.inventory.slots[36] = pickaxe
    bot.updateHeldItem()
    // a pool 3 deep (y 62 to 64) from x -3 to 1, its shore from x 2 (its top at 65), the stone on it at y 65 under
    // another: only its face to the water in sight, a block high
    for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = 62; y <= 64; y++) bot.world.setBlock(new Vec3(x, y, z), x <= 1 ? 'water' : 'stone')
    bot.world.setBlock(new Vec3(2, 65, 0), 'stone')
    bot.world.setBlock(new Vec3(2, 66, 0), 'stone')
    const stops: string[] = []
    bot.on('diggingAborted', (b: any) => stops.push(b.position.toString()))
    try {
      bot.entity.position = new Vec3(1.2, 64.2, 0.5)
      bot.setControlState('jump', true)
      await bot.waitForTicks(20)
      await withTimeout(digInSight(bot, bot.blockAt(new Vec3(2, 65, 0))), 30000, 'dig timed out')
      assert.equal(bot.blockAt(new Vec3(2, 65, 0)).name, 'air')
      assert.deepEqual(stops, [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
