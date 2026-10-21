import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { BlockInfo } from '../src/mineflayer-specific/world/cacheWorld'
import { createCacheWorld } from './setup'

// An infested block lets a silverfish out when broken, and its call wakes those in the infested blocks round it: no
// move breaks one (its cost to break infinite), the way goes round. A 26.3 bot mining iron at y 29 broke into a nest
// and was slain by 9 silverfish (f5-26.3).

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: every infested block is one no move breaks, and a path digs round a wall of them, not through`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    try {
      const infested = rig.mcData.blocksArray.filter((b: any) => b.name.startsWith('infested_'))
      for (const name of ['infested_stone', 'infested_cobblestone', 'infested_deepslate', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks', 'infested_chiseled_stone_bricks']) {
        assert.ok(infested.some((b: any) => b.name === name), `${name} in the registry`)
      }
      for (const b of infested) assert.ok(BlockInfo.blocksCantBreak.has(b.id), `${b.name} breakable`)

      // a tunnel's way along x at z 0 shut by a wall of infested stone at x 3 (z -1..1, y 64..65), stone round it all:
      // through the wall is 2 digs of infested stone, round it a longer dig of plain stone
      for (let x = -1; x <= 7; x++) for (let z = -3; z <= 3; z++) for (const y of [64, 65, 66]) bot.world.setBlock(new Vec3(x, y, z), 'stone')
      for (let x = 0; x <= 6; x++) for (const y of [64, 65]) bot.world.setBlock(new Vec3(x, y, 0), 'air')
      for (let z = -1; z <= 1; z++) for (const y of [64, 65]) bot.world.setBlock(new Vec3(3, y, z), 'infested_stone')
      await bot.waitForTicks(4)
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      const result = await plan(bot, new goals.GoalBlock(6, 64, 0))
      assert.equal(result.status, 'success')
      const breaks = result.path.flatMap((m: any) => m.toBreak.map((h: any) => bot.blockAt(h.vec)?.name))
      assert.ok(breaks.length > 0)
      assert.ok(!breaks.some((n: string) => n.startsWith('infested_')), `breaks: ${breaks.join(' ')}`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
