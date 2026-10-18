import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

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

test('a wall of leaves is dug through like any wall (leaves break by hand in 0.2 hardness)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(3, y, z), 'oak_leaves')
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success', JSON.stringify(result.path?.map((m: any) => [m.x, m.y, m.z])))
    assert.ok(result.path.some((m: any) => m.toBreak?.length > 0), 'the path breaks the leaves')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto walks through a wall of leaves, breaking the leaves in its way', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(3, y, z), 'oak_leaves')
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = new goals.GoalBlock(6, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, 'goto timed out')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd(at.floored() as any), `ended at ${at}`)
  } finally {
    rig.stopPassivePhysics()
  }
})
