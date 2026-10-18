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

test('a ForwardJump out of a two-high corridor onto a step jumps where the jump lands on it, not from under the corridor\'s ceiling', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  const failed: string[] = []
  rig.bot.on('pathfinderMoveFailed' as any, (info: any) => failed.push(String(info?.error)))
  try {
    // a corridor two high along x at z 0 (x 3 to 9, its ceiling at y 66), the cell at x 3 open up to y 68, and a step
    // at x 2 (stone at y 64, air above): a play run's way up out of a cave
    for (let x = -2; x <= 10; x++) for (let z = -2; z <= 2; z++) for (let y = 64; y <= 69; y++) world.setBlock(new Vec3(x, y, z), 'stone')
    for (let x = 3; x <= 9; x++) for (const y of [64, 65]) world.setBlock(new Vec3(x, y, 0), 'air')
    for (const y of [66, 67, 68]) world.setBlock(new Vec3(3, y, 0), 'air')
    for (const y of [65, 66, 67, 68]) world.setBlock(new Vec3(2, y, 0), 'air')
    // standing in the corridor, a block and a bit from the step: no planned jump (each bumps the step's face or the
    // ceiling), and the jump at once from under the ceiling fell short
    rig.bot.entity.position = new Vec3(4.25, 64, 0.5)
    let ticks = 0
    rig.bot.on('physicsTick', () => { ticks++ })
    const goal = new goals.GoalBlock(2, 65, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto timed out at ${rig.bot.entity.position}`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.deepEqual(failed, [])
    assert.ok(ticks < 100, `${ticks} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})
