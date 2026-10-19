import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Optimizer } from '../src/mineflayer-specific/post/optimizer'
import { createCacheWorld } from './setup'

/** the longest the event loop went without a 1 ms timer firing while `work` ran */
async function longestHold (work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now }, 1)
  try {
    last = performance.now()
    await work()
    longest = Math.max(longest, performance.now() - last)
  } finally {
    clearInterval(timer)
  }
  return longest
}

test('the optimizer lets the event loop through every searchTickBudgetMs: a straight run of 300 moves merged, as in one go', async () => {
  const { rig } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { renderDistance: 22 })
  try {
    rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50, searchTimeoutMs: 60000, searchTickBudgetMs: 40 } } as any))
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    let final: any
    for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(300, 64, 7))) final = res
    assert.equal(final.result.status, 'success')
    const path = final.result.path
    assert.ok(path.length >= 300, `${path.length} moves`)
    const pf: any = rig.bot.pathfinder
    const { optimizers } = pf.getActiveMappings()

    // in one go (a budget no slice reaches): how long the whole takes
    const whole = new Optimizer(rig.bot as any, pf.world, optimizers)
    ;(whole.clock as any).budgetMs = Infinity
    whole.loadPath(path.slice())
    let t = performance.now()
    const once = await whole.compute()
    const wholeMs = performance.now() - t

    const sliced = new Optimizer(rig.bot as any, pf.world, optimizers)
    sliced.loadPath(path.slice())
    let result: any[] = []
    t = performance.now()
    const hold = await longestHold(async () => { result = await sliced.compute() })
    assert.ok(wholeMs > 200, `the optimizer took ${wholeMs.toFixed(0)} ms in one go`)
    assert.ok(hold < 40 + 60, `the event loop was held ${hold.toFixed(0)} ms (the whole ${wholeMs.toFixed(0)} ms)`)
    assert.deepEqual(result.map((m) => m.exitPos.toString()), once.map((m) => m.exitPos.toString()))
  } finally {
    rig.stopPassivePhysics()
  }
})
