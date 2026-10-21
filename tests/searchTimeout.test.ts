import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals, GoalNotReachedError } from '../src'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

function rigWith (pathfinderSettings: Record<string, unknown>) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50, ...pathfinderSettings } } as any))
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  return rig
}

test('a search with no way to its goal stops after searchTimeoutMs of computing instead of going on for good', async () => {
  // a block up, with nothing to place: the flat world round it is searched for ever
  const rig = rigWith({ searchTimeoutMs: 300 })
  try {
    const start = performance.now()
    // (short of the goal: GoalNotReachedError, the search's timeout)
    const err = await withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(0, 65, 0)).then(() => null, (e: unknown) => e), 10000, 'goto searched on for good')
    assert.ok(err instanceof GoalNotReachedError && err.reason === 'timeout', `goto ended with ${String((err as Error)?.message ?? err)}`)
    assert.ok(performance.now() - start < 5000, `${performance.now() - start} ms`)
    assert.ok(rig.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) < 1.5, `the bot went to ${rig.bot.entity.position}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

for (const partialPathProducer of [false, true]) {
  test(`a search that runs out of time goes the way to the best node it got to (partialPathProducer: ${partialPathProducer})`, async () => {
    // a goal shut in a bedrock box, nothing to dig with: the flat world round it is searched for ever
    const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({
      pathfinderSettings: { partialPathProducer, partialPathLength: 50, searchTimeoutMs: 500 },
      moveSettings: { canDig: false }
    } as any))
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const world = (rig.bot as any).world
    try {
      for (let x = 11; x <= 13; x++) {
        for (let y = 64; y <= 67; y++) {
          for (let z = -1; z <= 1; z++) {
            if (x === 12 && z === 0 && y < 66) continue
            world.setBlock(new Vec3(x, y, z), 'bedrock')
          }
        }
      }
      const timedOut: number[] = []
      rig.bot.on('pathGenerated', (res: any) => { if (res.status === 'timeout') timedOut.push(res.path.length) })
      const goal = new goals.GoalBlock(12, 64, 0)
      // (short of the goal: GoalNotReachedError, the last search's timeout no nearer)
      const err = await withTimeout(rig.bot.pathfinder.goto(goal).then(() => null, (e: unknown) => e), 30000, `goto searched on for good (at ${rig.bot.entity.position})`)
      assert.ok(err instanceof GoalNotReachedError && err.reason === 'timeout', `goto ended with ${String((err as Error)?.message ?? err)}`)
      const at = rig.bot.entity.position
      assert.ok(timedOut.length > 0 && timedOut[0] > 0, `timed out searches: ${timedOut.join(', ')}`)
      // up to the box, the nearest the goal it can get
      assert.ok(at.distanceTo(new Vec3(12.5, 64, 0.5)) < 3, `ended at ${at}`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
