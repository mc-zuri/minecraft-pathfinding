import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals, isAvoidedMob, collectAvoidances, cellCostFactor } from '../src'
import { buildMovementOptions } from '../src/mineflayer-specific/movements'
import { createCacheWorld } from './setup'

// The search's costs round hostile mobs and spawners, and toward the path walked before (Baritone's Avoidance and
// Favoring, re-implemented: avoidance.ts).

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

test('of two ways round a wall as long as each other, a path takes the one away from a hostile mob (a move ending within 8 of it costs 1.5 times as much), whichever side it is on', async () => {
  const rig = createCacheWorld('1.21.11', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false, canPlace: false } } as any))
  const bot: any = rig.bot
  try {
    // a wall of bedrock along x from 2 to 18 at z 0, 3 high: round it by z 1 or by z -1
    for (let x = 2; x <= 18; x++) for (const y of [64, 65, 66]) bot.world.setBlock(new Vec3(x, y, 0), 'bedrock')
    await bot.waitForTicks(4)
    const goal = new goals.GoalBlock(20, 64, 0)
    for (const side of [1, -1]) {
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      // the zombie 6 off the wall on this side
      bot.entities[777] = { id: 777, name: 'zombie', type: 'hostile', position: new Vec3(10, 64, 6 * side), metadata: {} }
      const result = await plan(bot, goal)
      assert.equal(result.status, 'success')
      const along = result.path.filter((m: any) => m.exitPos.x > 3 && m.exitPos.x < 17)
      assert.ok(along.length > 0 && along.every((m: any) => Math.sign(m.exitPos.z - 0.5) === -side), `the way by the zombie at z ${6 * side}: ${along.map((m: any) => m.exitPos.floored().toString()).join(' ')}`)
    }
  } finally {
    rig.stopPassivePhysics()
  }
})

test('which mobs are kept away from: hostiles; a spider only in the dark, a zombified piglin only angry, an enderman only provoked; no passive mob', () => {
  let light = { light: 0, skyLight: 15 }
  let isDay = true
  const bot: any = { entity: {}, time: { get isDay () { return isDay } }, blockAt: () => light }
  const mob = (name: string, metadata: any = {}, type = 'hostile'): any => ({ name, type, position: new Vec3(0, 64, 0), metadata })
  assert.equal(isAvoidedMob(bot, mob('zombie')), true)
  assert.equal(isAvoidedMob(bot, mob('cow', {}, 'animal')), false)
  assert.equal(isAvoidedMob(bot, mob('spider')), false, 'a spider by day under the sky')
  isDay = false
  assert.equal(isAvoidedMob(bot, mob('spider')), true, 'a spider at night')
  isDay = true
  light = { light: 0, skyLight: 0 }
  assert.equal(isAvoidedMob(bot, mob('cave_spider')), true, 'a spider in a cave')
  assert.equal(isAvoidedMob(bot, mob('zombified_piglin')), false)
  assert.equal(isAvoidedMob(bot, mob('zombified_piglin', { aggressive: true })), true)
  assert.equal(isAvoidedMob(bot, mob('enderman')), false)
  assert.equal(isAvoidedMob(bot, mob('enderman', { creepy: true })), true)
})

test('a spawner within 16 doubles a move\'s cost, a mob within 8 multiplies it by 1.5 (each), a cell of the path walked before halves it', () => {
  const settings = buildMovementOptions({})
  const bot: any = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 1: { name: 'zombie', type: 'hostile', position: new Vec3(0, 64, 0) }, 2: { name: 'skeleton', type: 'hostile', position: new Vec3(2, 64, 0) } },
    registry: { blocksByName: { spawner: { id: 99 } } },
    findBlocks: () => [new Vec3(30, 64, 0)],
    blockAt: () => null
  }
  const avoidances = collectAvoidances(bot, settings)
  assert.equal(avoidances.length, 3)
  const factor = (x: number, favored?: Set<string>): number => cellCostFactor(avoidances, favored, settings.backtrackFavoringCoefficient, x, 64, 0)
  assert.equal(factor(1), 1.5 * 1.5)
  assert.equal(factor(9), 1.5)
  assert.equal(factor(12), 1)
  assert.equal(factor(16), 2)
  assert.equal(factor(12, new Set(['12,64,0'])), 0.5)
  assert.equal(collectAvoidances(bot, buildMovementOptions({ avoidance: false } as any)).length, 0)
})
