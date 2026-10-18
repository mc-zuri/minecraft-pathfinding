import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { CancelError } from '../src/mineflayer-specific/exceptions'
import { Diagonal, Forward } from '../src/mineflayer-specific/movements/movementProviders'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

function rigFailing (fails: (calls: number) => boolean) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  // no optimizer: every block a Forward move of its own, each run by the executor below
  rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
  let calls = 0
  class FailingForwardExecutor extends NewForwardExecutor {
    async performPerTick (thisMove: any, tickCount: number, currentIndex: number, path: any[]): Promise<boolean | number> {
      if (tickCount === 0 && fails(++calls)) throw new CancelError('the test\'s move failed')
      return await super.performPerTick(thisMove, tickCount, currentIndex, path)
    }
  }
  rig.bot.pathfinder.setExecutor(Forward, FailingForwardExecutor)
  rig.bot.pathfinder.setExecutor(Diagonal, FailingForwardExecutor)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  return rig
}

test('a move that fails has goto search again from where the bot is, and go on to the goal', async () => {
  // the second Forward move fails once
  const rig = rigFailing((calls) => calls === 2)
  try {
    const goal = new goals.GoalBlock(8, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 20000, 'goto timed out')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('moves that keep failing at one place end goto with an error', async () => {
  const rig = rigFailing(() => true)
  try {
    await assert.rejects(withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(8, 64, 0)), 20000, 'goto timed out'), /moves in a row failed at .* \(the last: Movement canceled: the test's move failed\)/)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a move that holds the bot still fails after NO_PROGRESS_TICKS, and the next search goes round it', async () => {
  const { NO_PROGRESS_TICKS } = await import('../src/pathExecutor')
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
  let held = 0
  // the Forward move onto (2, 64, 0) never gets anywhere (a jump it never lines up for, a corner it presses into)
  class StuckForwardExecutor extends NewForwardExecutor {
    async align (thisMove: any, tickCount: number, goal: any): Promise<boolean> {
      if (Math.floor(thisMove.exitPos.x) === 2 && Math.floor(thisMove.exitPos.z) === 0) {
        held++
        rig.bot.clearControlStates()
        return false
      }
      return await super.align(thisMove, tickCount, goal)
    }
  }
  rig.bot.pathfinder.setExecutor(Forward, StuckForwardExecutor)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  try {
    const goal = new goals.GoalBlock(4, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, 'goto timed out')
    const at = rig.bot.entity.position
    assert.ok(Math.hypot(at.x - 4.5, at.z - 0.5) < 1, `ended at ${at}`)
    assert.deepEqual([...rig.bot.pathfinder.failedMoves], ['Forward:1,64,0>2,64,0'])
    assert.ok(held >= NO_PROGRESS_TICKS && held < 3 * NO_PROGRESS_TICKS, `held ${held} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})
