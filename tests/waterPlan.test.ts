import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { LADDER_UP_ONE_COST } from '../src/mineflayer-specific/movements/costs'
import { createCacheWorld } from './setup'

// Water planned at the surface (Baritone's canWalkThrough and MovementPillar, re-implemented): a move ends with the
// feet in water only in the water's top cell, the head out (a swimmer there breathes, and its jump keeps it), never
// in a flowing cell (a level 1 to 7, or a full cell beside one); a column of water the bot is in is swum up at a
// ladder's cost. Paths along the sea's floor ran a 1.21.11 bot out of air (f1-grim).

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

const describe = (path: any[]): string => path.map((m: any) => `${m.moveType.constructor.name}>${m.exitPos.floored().toString()}`).join(' ')

/** a sea from x -8 to 8 (z -8..8), its water y 54..62 over stone, the shore at x 9 on (the feet on it at 63) */
async function seaRig (version: string) {
  const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false, canPlace: false } } as any))
  const bot: any = rig.bot
  for (let x = -8; x <= 14; x++) {
    for (let z = -8; z <= 8; z++) {
      for (let y = 53; y <= 63; y++) bot.world.setBlock(new Vec3(x, y, z), x <= 8 ? (y === 53 ? 'stone' : y <= 62 ? 'water' : 'air') : (y <= 62 ? 'stone' : 'air'))
    }
  }
  await bot.waitForTicks(4)
  return { rig, bot }
}

for (const version of ['1.21.11', '26.3']) {
  test(`${version}: a path from deep under the sea swims up its water column at a ladder's cost and on along the surface, no move ending with the head under water`, async () => {
    const { rig, bot } = await seaRig(version)
    try {
      bot.entity.position = new Vec3(-2.5, 56.2, 0.5)
      bot.entity.velocity = new Vec3(0, 0, 0)
      const result = await plan(bot, new goals.GoalBlock(11, 63, 0))
      assert.equal(result.status, 'success', describe(result.path))
      for (const m of result.path) {
        const head = bot.blockAt(m.exitPos.floored().offset(0, 1, 0))?.name
        if (m.moveType.constructor.name === 'StraightUp') continue
        assert.notEqual(head, 'water', `${m.moveType.constructor.name} to ${m.exitPos.toString()} ends with the head under water: ${describe(result.path)}`)
      }
      const climbs = result.path.filter((m: any) => m.moveType.constructor.name === 'StraightUp' && bot.blockAt(m.exitPos.floored().offset(0, 1, 0))?.name === 'water')
      assert.ok(climbs.length >= 4, describe(result.path))
      for (const m of climbs) assert.ok(Math.abs(m.cost - LADDER_UP_ONE_COST) < 1e-6, `a water column's climb cost ${m.cost}`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('flowing water isn\'t walked through: a level 1 to 7 cell, or a full cell beside one; the still water past it is', async () => {
  const rig = createCacheWorld('1.21.11', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false, canPlace: false } } as any))
  const bot: any = rig.bot
  const water = rig.mcData.blocksByName.water.minStateId
  try {
    // a stream across the way at x 3, z -4..4 (the feet's cell, over the floor): flowing at level 3, a source in its
    // middle beside the flow; the way round it longer
    for (let z = -4; z <= 4; z++) bot.world.setBlock(new Vec3(3, 64, z), { stateId: water + (z === 0 ? 0 : 3) })
    for (const z of [-5, 5]) for (let x = -2; x <= 8; x++) for (const y of [64, 65, 66]) bot.world.setBlock(new Vec3(x, y, z), 'bedrock')
    await bot.waitForTicks(4)
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    const result = await plan(bot, new goals.GoalBlock(6, 64, 0))
    const through = result.path.filter((m: any) => m.exitPos.floored().x === 3 && Math.abs(m.exitPos.floored().z) <= 4)
    assert.equal(through.length, 0, `stood in the stream: ${describe(result.path)}`)

    // the stream still (sources all along it): walked through
    for (let z = -4; z <= 4; z++) bot.world.setBlock(new Vec3(3, 64, z), { stateId: water })
    await bot.waitForTicks(4)
    const still = await plan(bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(still.status, 'success', describe(still.path))
  } finally {
    rig.stopPassivePhysics()
  }
})
