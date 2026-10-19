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

test('a path from on top of a block lower than a full one (farmland, 15/16) starts on it, not in it: no floor dug', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // a farm's farmland in the grass, the bot standing on it (its top at 15/16: Entity's y 63.9375)
    for (let x = 0; x <= 3; x++) for (let z = -1; z <= 1; z++) world.setBlock(new Vec3(x, 63, z), 'farmland')
    rig.bot.entity.position = new Vec3(0.5, 63.9375, 0.5)
    const dug: string[] = []
    const dig = rig.bot.dig.bind(rig.bot)
    ;(rig.bot as any).dig = async (block: any, ...rest: any[]) => { dug.push(`${String(block?.name)} ${String(block?.position)}`); return await dig(block, ...rest) }
    const goal = new goals.GoalBlock(6, 64, 4)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto timed out at ${rig.bot.entity.position.toString()}`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at.toString()}`)
    // the path walked over the ground: it dug through none of it (it dug the farmland and the grass at the feet's
    // floored height, 63, the start node's)
    assert.deepEqual(dug, [])
    for (let x = 0; x <= 3; x++) for (let z = -1; z <= 1; z++) assert.equal(world.getBlock(new Vec3(x, 63, z))?.name, 'farmland')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a path from farmland the bot stands on the edge of, its middle over the water beside it, starts on the farmland', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // the farm's water in the ground, the farmland round it
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) world.setBlock(new Vec3(x, 63, z), x === 0 && z === 0 ? 'water' : 'farmland')
    // over the water's middle by 0.25, the box's edge on the farmland east of it
    rig.bot.entity.position = new Vec3(0.75, 63.9375, 0.5)
    const dug: string[] = []
    const dig = rig.bot.dig.bind(rig.bot)
    ;(rig.bot as any).dig = async (block: any, ...rest: any[]) => { dug.push(`${String(block?.name)} ${String(block?.position)}`); return await dig(block, ...rest) }
    const goal = new goals.GoalBlock(6, 64, 4)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto timed out at ${rig.bot.entity.position.toString()}`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at.toString()}`)
    assert.deepEqual(dug, [])
  } finally {
    rig.stopPassivePhysics()
  }
})
