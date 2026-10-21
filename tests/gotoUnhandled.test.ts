import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals, GoalNotReachedError } from '../src'
import { createCacheWorld } from './setup'

test('goto: a walk of a partial path that fails after the search ended (noPath) is no unhandled rejection', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: true, partialPathLength: 5 } } as any))
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const pf: any = rig.bot.pathfinder
    // the search: a part of the way (the walk starts on it), then no path; the walk fails a few ticks on (a move that
    // took too long to start, PathExecutor's CancelError)
    pf.getPathTo = async function * () {
      yield { result: { status: 'partialSuccess', path: [{}], cost: 1 }, astarContext: {} }
      yield { result: { status: 'noPath', path: [], cost: 0 }, astarContext: {} }
    }
    pf.perform = async () => {
      await rig.bot.waitForTicks(3)
      throw new Error('StraightUp took over 191 ticks to start')
    }
    // (goto itself ends short of the goal: GoalNotReachedError, its search's noPath)
    await assert.rejects(pf.goto(new goals.GoalBlock(10, 64, 0)), (err: any) => err instanceof GoalNotReachedError && err.reason === 'noPath')
    await rig.bot.waitForTicks(6)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled.map((e) => (e as Error).message), [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
    rig.stopPassivePhysics()
  }
})
