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

test('a move on a turn ends where the next can start: the bot goes round the corners of a one-wide zigzag tunnel without catching on them', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: true, partialPathLength: 50 } } as any))
  const world = (rig.bot as any).world
  try {
    // a tunnel one block wide and two high in solid stone, turning left and right every 4 blocks
    const open = new Set<string>()
    let x = 0
    let z = 0
    open.add('0,0')
    for (const [dx, dz, n] of [[1, 0, 4], [0, -1, 4], [1, 0, 4], [0, 1, 4], [1, 0, 4], [0, -1, 3]]) {
      for (let i = 0; i < n; i++) { x += dx; z += dz; open.add(`${x},${z}`) }
    }
    for (let wx = -3; wx <= x + 3; wx++) {
      for (let wz = -10; wz <= 10; wz++) {
        if (open.has(`${wx},${wz}`)) continue
        for (let y = 64; y < 67; y++) world.setBlock(new Vec3(wx, y, wz), 'stone')
      }
    }
    // stone over the tunnel too, so that it can't be walked over the top
    for (const key of open) {
      const [ox, oz] = key.split(',').map(Number)
      world.setBlock(new Vec3(ox, 66, oz), 'stone')
    }
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    let ticks = 0
    let collided = 0
    rig.bot.on('physicsTick', () => {
      ticks++
      if ((rig.bot.entity as any).isCollidedHorizontally === true) collided++
    })
    const goal = new goals.GoalBlock(x, 64, z)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto through the tunnel timed out at ${rig.bot.entity.position} (${collided} of ${ticks} ticks against a wall)`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    // 23 blocks: about 5 ticks a block at a walk; it used to press into the first corner for good
    assert.ok(ticks < 250, `${ticks} ticks`)
    assert.ok(collided < ticks / 4, `${collided} of ${ticks} ticks against a wall`)
  } finally {
    rig.stopPassivePhysics()
  }
})
