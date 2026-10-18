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

test('a move that holds the bot still fails after NO_PROGRESS_TICKS, the next search goes round it, and goto ends with the bot stopped in the goal (the diagonal run in left it off the goal block)', async () => {
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
    // in the goal's block and stopped there: the diagonal run in doesn't carry it off after goto (the arrive's stop)
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.deepEqual([...rig.bot.pathfinder.failedMoves], ['Forward:1,64,0>2,64,0'])
    assert.ok(held >= NO_PROGRESS_TICKS && held < 3 * NO_PROGRESS_TICKS, `held ${held} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a move that goes on and on without getting there (backing up for a jump and walking up to it again) fails after MOVE_TICKS_FACTOR times its cost', async () => {
  const { MIN_MOVE_TICKS } = await import('../src/pathExecutor')
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
  let dithered = 0
  class DitherForwardExecutor extends NewForwardExecutor {
    async align (thisMove: any, tickCount: number, goal: any): Promise<boolean> {
      if (Math.floor(thisMove.exitPos.x) === 2 && Math.floor(thisMove.exitPos.z) === 0) {
        dithered++
        // back and forth along x, a block's length each way, never onto the move's block
        rig.bot.clearControlStates()
        void rig.bot.look(-Math.PI / 2, 0, true)
        rig.bot.setControlState(Math.floor(dithered / 10) % 2 === 0 ? 'back' : 'forward', true)
        return false
      }
      return await super.align(thisMove, tickCount, goal)
    }
  }
  rig.bot.pathfinder.setExecutor(Forward, DitherForwardExecutor)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  try {
    const goal = new goals.GoalNear(4, 64, 0, 1)
    await withTimeout(rig.bot.pathfinder.goto(goal), 40000, 'goto timed out')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.ok(dithered >= MIN_MOVE_TICKS && dithered < 3 * MIN_MOVE_TICKS, `dithered ${dithered} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a dig that fails fails its move (the search goes again), and doesn\'t stay the move\'s interaction with the bot walking into the block', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  const world = (rig.bot as any).world
  // dirt across the way, 2 high, a long way to either side (put there before the pathfinder listens for updates)
  for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(3, y, z), y < 66 ? 'dirt' : 'stone')
  rig.bot.loadPlugin(createPlugin())
  try {
    const dig = rig.bot.dig.bind(rig.bot)
    let digs = 0
    rig.bot.dig = async (...args: any[]) => {
      // the first dig is refused (the server answers "Digging aborted")
      if (++digs === 1) { failedAt = ticks; throw new Error('Digging aborted') }
      return await dig(...args)
    }
    let ticks = 0
    let failedAt = -1
    let searchedAgainAt = -1
    rig.bot.on('physicsTick', () => { ticks++ })
    rig.bot.on('pathGenerated', () => { if (failedAt >= 0 && searchedAgainAt < 0) searchedAgainAt = ticks })
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = new goals.GoalBlock(5, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto timed out at ${rig.bot.entity.position} after ${digs} digs`)
    const at = rig.bot.entity.position
    assert.ok(Math.hypot(at.x - 5.5, at.z - 0.5) < 1.2, `ended at ${at}`)
    assert.ok(digs > 1)
    // at once: the move fails on its next tick, not after the no-progress check's 60 ticks against the block
    assert.ok(searchedAgainAt >= 0 && searchedAgainAt - failedAt < 30, `searched again ${searchedAgainAt - failedAt} ticks after the failed dig`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a move whose start (its digs and places before it sets off) never ends fails after MOVE_TICKS_FACTOR times its cost, and the search goes round it', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
  let hung = 0
  class HungStartExecutor extends NewForwardExecutor {
    async performInit (thisMove: any, currentIndex: number, path: any[]): Promise<void> {
      if (Math.floor(thisMove.exitPos.x) === 2 && Math.floor(thisMove.exitPos.z) === 0) {
        hung++
        return await new Promise(() => {})
      }
      return await super.performInit(thisMove, currentIndex, path)
    }
  }
  rig.bot.pathfinder.setExecutor(Forward, HungStartExecutor)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  try {
    const goal = new goals.GoalNear(4, 64, 0, 1)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, 'goto hung on the move\'s start')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.equal(hung, 1)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a dig whose block is gone but whose promise never answers doesn\'t hold the move: it goes on a few ticks later', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  const world = (rig.bot as any).world
  for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(3, y, z), y < 66 ? 'dirt' : 'stone')
  rig.bot.loadPlugin(createPlugin())
  try {
    let digs = 0
    // the block breaks (the server's update comes), the dig's own answer never does
    rig.bot.dig = async (block: any) => {
      digs++
      world.setBlock(block.position, 'air')
      return await new Promise<void>(() => {})
    }
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = new goals.GoalNear(5, 64, 0, 1)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `goto held at ${rig.bot.entity.position} after ${digs} digs`)
    assert.ok(digs >= 2)
  } finally {
    rig.stopPassivePhysics()
  }
})
