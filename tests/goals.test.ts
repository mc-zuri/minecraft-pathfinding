import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { goals } from '../src'
import { createCacheWorld } from './setup'

// the ground's top is y = 63: the bot stands at 64
const node = (x: number, y: number, z: number): any => ({ x: x + 0.5, y, z: z + 0.5 })

test('GoalMineBlock ends beside a block with no collision box (sugar cane), and not with a wall in the way', () => {
  const { world, rig, cacheWorld } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { trackRenderDistance: false })
  try {
    world.setBlock(new Vec3(3, 64, 0), 'sugar_cane')
    world.setBlock(new Vec3(3, 65, 0), 'sugar_cane')
    world.setBlock(new Vec3(6, 64, 0), 'stone')
    const cane = cacheWorld.getBlock(new Vec3(3, 65, 0)) as any
    assert.equal(cane.name, 'sugar_cane')
    assert.equal(cane.shapes.length, 0)
    const goal = goals.GoalMineBlock.fromBlock(cacheWorld as any, cane, 4, 1.62)
    // the raycast passes through the cane: the goal still holds next to it
    assert.equal(goal.isEnd(node(2, 64, 0)), true)
    assert.equal(goal.isEnd(node(3, 64, 1)), true)
    // too far
    assert.equal(goal.isEnd(node(-3, 64, 0)), false)
    // a solid block between the eyes and the cane
    world.setBlock(new Vec3(2, 65, 0), 'stone')
    world.setBlock(new Vec3(2, 64, 0), 'stone')
    const blocked = goals.GoalMineBlock.fromBlock(cacheWorld as any, cacheWorld.getBlock(new Vec3(3, 65, 0)) as any, 4, 1.62)
    assert.equal(blocked.isEnd(node(1, 64, 0)), false)

    // a solid target is hit by the ray as before
    const stone = goals.GoalMineBlock.fromBlock(cacheWorld as any, cacheWorld.getBlock(new Vec3(6, 64, 0)) as any, 4, 1.62)
    assert.equal(stone.isEnd(node(5, 64, 0)), true)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('GoalLookAt holds out to its distance: the eyes within 4 blocks of a block in sight, not only beside it', () => {
  const { world, rig, cacheWorld } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { trackRenderDistance: false })
  try {
    world.setBlock(new Vec3(6, 64, 0), 'stone')
    const stone = goals.GoalMineBlock.fromBlock(cacheWorld as any, cacheWorld.getBlock(new Vec3(6, 64, 0)) as any, 4, 1.62)
    assert.equal(stone.isEnd(node(5, 64, 0)), true)
    // diagonal, 1.8 blocks off; and 3 blocks off on the level (the eyes 3.2 from the block's middle)
    assert.equal(stone.isEnd(node(7, 64, 1)), true)
    assert.equal(stone.isEnd(node(3, 64, 0)), true)
    // 5 blocks off: out of the distance
    assert.equal(stone.isEnd(node(1, 64, 0)), false)
    const near = goals.GoalMineBlock.fromBlock(cacheWorld as any, cacheWorld.getBlock(new Vec3(6, 64, 0)) as any, 2, 1.62)
    assert.equal(near.isEnd(node(3, 64, 0)), false)
  } finally {
    rig.stopPassivePhysics()
  }
})
