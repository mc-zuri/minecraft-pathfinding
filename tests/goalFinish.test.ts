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

for (const partialPathProducer of [false, true]) {
  test(`goto ends short of a GoalMineBlock (its block shut in bedrock): the goal's dig (onFinish) isn't run from there (partialPathProducer: ${partialPathProducer})`, async () => {
    const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({
      pathfinderSettings: { partialPathProducer, partialPathLength: 50, searchTimeoutMs: 500 },
      moveSettings: { canDig: false }
    } as any))
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const world = (rig.bot as any).world
    try {
      // a stone in a bedrock box: no node sees it, and nothing digs in
      for (let x = 11; x <= 13; x++) {
        for (let y = 63; y <= 66; y++) {
          for (let z = -1; z <= 1; z++) world.setBlock(new Vec3(x, y, z), 'bedrock')
        }
      }
      world.setBlock(new Vec3(12, 64, 0), 'stone')
      const goal = goals.GoalMineBlock.fromBlock(rig.bot.pathfinder.world as any, rig.bot.blockAt(new Vec3(12, 64, 0)) as any, 4, 1.62)
      let finished = 0
      goal.onFinish = async () => { finished++ }
      await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto searched on for good (at ${rig.bot.entity.position})`)
      assert.ok(rig.bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) > 3, `the bot stayed at ${rig.bot.entity.position}`)
      assert.equal(finished, 0, `onFinish ran at ${rig.bot.entity.position}, where the goal doesn't hold`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('goto to a GoalMineBlock that holds where it ends runs the goal\'s dig (onFinish)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 }, moveSettings: { canDig: false } } as any))
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  const world = (rig.bot as any).world
  try {
    world.setBlock(new Vec3(10, 64, 0), 'stone')
    const goal = goals.GoalMineBlock.fromBlock(rig.bot.pathfinder.world as any, rig.bot.blockAt(new Vec3(10, 64, 0)) as any, 4, 1.62)
    let finished = 0
    goal.onFinish = async () => { finished++ }
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto went on for good (at ${rig.bot.entity.position})`)
    assert.ok(rig.bot.pathfinder.goalHolds(goal), `the goal doesn't hold at ${rig.bot.entity.position}`)
    assert.equal(finished, 1)
  } finally {
    rig.stopPassivePhysics()
  }
})

for (const [what, now] of [['broken (air)', 'air'], ['changed to another block', 'dirt']] as const) {
  test(`a GoalMineBlock whose block was ${what} since it was made isn't dug at its end: its goto returns (mineflayer's dig of a place that's air never ended, and the cleanup waited on it)`, async () => {
    const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 }, moveSettings: { canDig: false } } as any))
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const world = (rig.bot as any).world
    try {
      world.setBlock(new Vec3(10, 64, 0), 'stone')
      const goal = goals.GoalMineBlock.fromBlock(rig.bot.pathfinder.world as any, rig.bot.blockAt(new Vec3(10, 64, 0)) as any, 4, 1.62)
      const dug: string[] = []
      const bot = rig.bot as any
      bot.dig = async (block: any) => { dug.push(block.name); await new Promise(() => {}) }
      // dug by something else after the goal was made (its Block kept)
      world.setBlock(new Vec3(10, 64, 0), now)
      await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto went on for good (at ${rig.bot.entity.position})`)
      assert.ok(rig.bot.pathfinder.goalHolds(goal), `the goal doesn't hold at ${rig.bot.entity.position}`)
      assert.deepEqual(dug, [])
      assert.equal(rig.bot.pathfinder.isPathing, false)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('a GoalMineBlock whose block is still there is dug at its end, the block the world has now', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 }, moveSettings: { canDig: false } } as any))
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  const world = (rig.bot as any).world
  try {
    world.setBlock(new Vec3(10, 64, 0), 'stone')
    const goal = goals.GoalMineBlock.fromBlock(rig.bot.pathfinder.world as any, rig.bot.blockAt(new Vec3(10, 64, 0)) as any, 4, 1.62)
    const dug: string[] = []
    const bot = rig.bot as any
    bot.dig = async (block: any) => { dug.push(`${block.name} ${block.position}`) }
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto went on for good (at ${rig.bot.entity.position})`)
    assert.deepEqual(dug, ['stone (10, 64, 0)'])
  } finally {
    rig.stopPassivePhysics()
  }
})
