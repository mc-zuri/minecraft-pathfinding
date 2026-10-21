import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { PlaceHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

// A pillar's StraightUp whose walk is reset as its place waits for the jump (a block update near the path: the snow over
// the block the bot dug fell, f9-26.3 t51095): the place given up on went on and placed, the next path's StraightUp
// placed the same cell in the same tick, and its click on the cell the first one's prediction filled failed 'No block
// has been placed : the block is still dirt' (mineflayer's placeBlockWithOptions: the block before it already dirt).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a pillar's place given up on as it waits (the walk reset) sends nothing, the next path's place of the cell is the only one and the bot gets up (f9-26.3: 'No block has been placed : the block is still dirt')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    const bot: any = rig.bot
    bot.inventory.items = () => [{ type: bot.registry.itemsByName.dirt.id, count: 10, name: 'dirt', slot: 36 }]
    bot.loadPlugin(createPlugin({ moveSettings: { scaffoldReserve: 0 } as any }))
    // a shaft a block wide round the bot, 3 high: the way up is a pillar
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = 64; y <= 66; y++) if (x !== 0 || z !== 0) bot.world.setBlock(new Vec3(x, y, z), 'stone')
    // mineflayer's place: the block at the cell before the click, and a click that leaves it as it was fails
    const places: string[] = []
    const place = bot._placeBlockWithOptions
    bot._placeBlockWithOptions = async (ref: any, face: any, opts: any) => {
      const dest = ref.position.plus(face)
      const before = bot.blockAt(dest)
      places.push(`${dest.toString()} ${String(before?.name)}`)
      await place(ref, face, opts)
      if (before?.name !== 'air') throw new Error(`No block has been placed : the block is still ${String(before?.name)}`)
    }
    // the walk reset as the first place starts (the bot on the ground still, safe to cancel at once)
    const perform = PlaceHandler.prototype.perform
    let performs = 0
    PlaceHandler.prototype.perform = function (this: PlaceHandler, ...args: Parameters<typeof perform>) {
      if (performs++ === 0) void bot.pathfinder.reset('blockUpdate')
      return perform.apply(this, args)
    }
    const failed: string[] = []
    bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
    await bot.waitForTicks(4)
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(0, 65, 0)), 20000, `goto timed out at ${bot.entity.position}`)
      assert.ok(performs >= 2, `the place started ${performs} times: no reset under way`)
      assert.deepEqual(places, [`${new Vec3(0, 64, 0).toString()} air`])
      assert.deepEqual(failed, [])
      assert.equal(Math.floor(bot.entity.position.y), 65)
    } finally {
      PlaceHandler.prototype.perform = perform
      rig.stopPassivePhysics()
    }
  })
}
