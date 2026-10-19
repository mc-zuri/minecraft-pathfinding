import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld, loadMcData } from './setup'

const VERSION = '1.20.4'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

async function finalPath (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  await withTimeout((async () => { for await (const res of bot.pathfinder.getPathTo(goal)) final = res })(), 15000, 'planning timed out')
  return final.result
}

/** the state id of a block with these properties (the rest as the block's default state) */
function stateOf (name: string, props: Record<string, unknown>): number {
  const { Block, mcData } = loadMcData(VERSION)
  const defaults = Block.fromStateId(mcData.blocksByName[name].defaultState as number, 0).getProperties()
  return (Block as any).fromProperties(name, { ...defaults, ...props }, 0).stateId
}

/**
 * A wall along x = 3 (z -20 to 20, 3 high) with one opening at z = 0, which `fill` fills: the bot at (0.5, 64, 0.5),
 * the goal past the wall at (6, 64, 0)
 */
function walled (fill: (world: any) => void, wall = 'stone'): ReturnType<typeof createCacheWorld>['rig'] {
  const rig = createCacheWorld(VERSION, 64, new Vec3(0, 64, 0)).rig
  const world = (rig.bot as any).world
  for (let y = 64; y < 67; y++) for (let z = -20; z <= 20; z++) if (z !== 0 || y === 66) world.setBlock(new Vec3(3, y, z), wall)
  fill(world)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  return rig
}

test('an open fence gate is walked through, not dug (its open state has no collision shape: FenceGateBlock)', async () => {
  const rig = walled((world) => {
    world.setBlock(new Vec3(3, 64, 0), stateOf('oak_fence_gate', { facing: 'east', open: true }))
    world.setBlock(new Vec3(3, 65, 0), 'air')
  }, 'oak_fence')
  rig.bot.loadPlugin(createPlugin())
  try {
    const info = rig.bot.pathfinder.world.getBlockInfo(new Vec3(3, 64, 0))
    assert.equal(info.physical, false)
    assert.equal(info.walkthrough, true)
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    assert.deepEqual(result.path.flatMap((m: any) => m.toBreak.map((b: any) => b.vec.toString())), [], 'nothing is dug')
    assert.ok(result.path.some((m: any) => m.x === 3 && m.z === 0), 'the path goes through the gate')
  } finally {
    rig.stopPassivePhysics()
  }
})
