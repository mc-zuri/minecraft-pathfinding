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

test('a dig on a move steered off its block (the optimizer\'s diagonal round a corner) holds the crosshair: the bot stands to mine and the steering leaves the look to the dig', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  const failed: string[] = []
  rig.bot.on('pathfinderMoveFailed' as any, (info: any) => failed.push(String(info?.error)))
  try {
    // the bottom of a shaft (0, 64, 0) dug into dirt, a way on to (-1, 64, -1) through the dirt at (-1, 64, 0): a
    // play run's pit, where the bot dug its way out along the merged diagonal from the shaft to the cell beyond
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 67; y++) world.setBlock(new Vec3(x, y, z), 'dirt')
    for (let y = 64; y <= 67; y++) world.setBlock(new Vec3(0, y, 0), 'air')
    for (const [x, y, z] of [[-1, 65, 0], [-1, 64, -1], [-1, 65, -1]]) world.setBlock(new Vec3(x, y, z), 'air')
    rig.bot.entity.position = new Vec3(0.3, 64, 0.3)
    let digs = 0
    rig.bot.on('diggingCompleted' as any, () => { digs++ })
    const goal = new goals.GoalBlock(-1, 64, -1)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto timed out at ${rig.bot.entity.position}`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    // the dig stopped each time the steering turned the bot along the diagonal at pitch 0, and the move failed
    assert.deepEqual(failed, [])
    assert.equal(world.getBlock(new Vec3(-1, 64, 0))?.name, 'air')
  } finally {
    rig.stopPassivePhysics()
  }
})
