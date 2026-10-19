import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { goals } from '../src'
import { createCacheWorld } from './setup'

// the ground's top is y = 63: the bot stands at 64 (a node is its block, as a Move's floored x, y, z)
const node = (x: number, y: number, z: number): any => ({ x, y, z })

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

test('GoalLookAt takes the eyes over the middle of the node block, not its corner: the same reach on every side', () => {
  const { world, rig, cacheWorld } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { trackRenderDistance: false })
  try {
    const at = new Vec3(0, 64, 0)
    world.setBlock(at, 'stone')
    const goal = goals.GoalMineBlock.fromBlock(cacheWorld as any, cacheWorld.getBlock(at) as any, 4, 1.62)
    // the eyes' distance to the block's box
    const reach = (x: number, y: number, z: number): number => {
      const e = new Vec3(x + 0.5, y + 1.62, z + 0.5)
      const d = (v: number, lo: number): number => Math.max(lo - v, 0, v - (lo + 1))
      return Math.hypot(d(e.x, at.x), d(e.y, at.y), d(e.z, at.z))
    }
    const ends: string[] = []
    for (let x = -7; x <= 7; x++) {
      for (let z = -7; z <= 7; z++) {
        if (!goal.isEnd(node(x, 64, z))) continue
        ends.push(`${x},${z}`)
        assert.ok(reach(x, 64, z) <= 4, `the goal holds at ${x} ${z}, the eyes ${reach(x, 64, z).toFixed(2)} from the block`)
      }
    }
    // the corner's eyes held at (3, 4) and (4, 3), 4.35 off, and not at (-4, -3) or (-3, -4), 3.7 off (the same as the
    // first, mirrored)
    for (const [x, z] of [[3, 3], [-3, -3], [3, -3], [-3, 3], [-4, 2], [4, -2], [2, -4], [-2, 4]]) {
      assert.equal(goal.isEnd(node(x, 64, z)), goal.isEnd(node(-x, 64, -z)), `${x} ${z} and its mirror`)
    }
    assert.ok(ends.length > 0)
  } finally {
    rig.stopPassivePhysics()
  }
})
