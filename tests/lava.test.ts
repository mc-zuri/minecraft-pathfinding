import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { BlockInfo } from '../src/mineflayer-specific/world/cacheWorld'
import { createCacheWorld } from './setup'

async function planTo (bot: any, goal: goals.Goal): Promise<{ status: string, path: Array<{ x: number, y: number, z: number }> }> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

test('lava, fire and cobwebs are neither walked through nor safe (BlockInfo.blocksToAvoid), air and water are', () => {
  const { world, rig } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5))
  try {
    const at = (name: string): BlockInfo => BlockInfo.fromBlock(world.setBlock(new Vec3(2, 64, 2), name) as any)
    for (const name of ['lava', 'fire', 'cobweb']) {
      const info = at(name)
      assert.equal(info.walkthrough, false, `${name} walkthrough`)
      assert.equal(info.safe, false, `${name} safe`)
    }
    for (const name of ['air', 'water']) {
      const info = at(name)
      assert.equal(info.walkthrough, true, `${name} walkthrough`)
      assert.equal(info.safe, true, `${name} safe`)
    }
  } finally {
    rig.stopPassivePhysics()
  }
})

test('powder snow, soul fire, berry bushes and wither roses are kept out of too (1.20.4 has them all)', () => {
  const { world, rig } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5))
  try {
    for (const name of ['powder_snow', 'soul_fire', 'sweet_berry_bush', 'wither_rose']) {
      const info = BlockInfo.fromBlock(world.setBlock(new Vec3(2, 64, 2), name) as any)
      assert.equal(info.walkthrough, false, `${name} walkthrough`)
      assert.equal(info.safe, false, `${name} safe`)
    }
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a path goes round a lava pool, not through it', async () => {
  const { world, rig } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5))
  try {
    const lava = new Set<string>()
    for (let x = 4; x <= 6; x++) {
      for (let z = -6; z <= 6; z++) {
        world.setBlock(new Vec3(x, 64, z), 'lava')
        lava.add(`${x},${z}`)
      }
    }
    rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: true, partialPathLength: 50 } }))
    const result = await planTo(rig.bot, new goals.GoalBlock(10, 64, 0))
    assert.equal(result.status, 'success')
    for (const node of result.path) assert.ok(!lava.has(`${node.x},${node.z}`) || node.y !== 64, `the path walks in the lava at ${node.x},${node.y},${node.z}`)
    assert.ok(Math.max(...result.path.map(n => Math.abs(n.z))) >= 7, 'the path doesn\'t go round the pool')
  } finally {
    rig.stopPassivePhysics()
  }
})
