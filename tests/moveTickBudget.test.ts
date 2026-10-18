import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Forward } from '../src/mineflayer-specific/movements/movementProviders'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

test('a movement tick that waits on the event loop (a packet, a timer) goes on over the next ticks instead of failing the walk after 40 ms', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  try {
    let waited = 0
    // every 5th tick of a Forward move waits 60 ms of wall clock, as a tick on a loaded machine or one awaiting a
    // server's answer does
    class SlowForwardExecutor extends NewForwardExecutor {
      async performPerTick (thisMove: any, tickCount: number, currentIndex: number, path: any[]): Promise<boolean | number> {
        if (tickCount % 5 === 0) {
          waited++
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        return await super.performPerTick(thisMove, tickCount, currentIndex, path)
      }
    }
    rig.bot.pathfinder.setExecutor(Forward, SlowForwardExecutor)
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = new goals.GoalBlock(8, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 20000, 'goto timed out')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.ok(waited > 0)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a movement tick that never ends fails the walk after MAX_TICK_IN_FLIGHT ticks instead of holding goto (and every later goto) for good', async () => {
  const { MAX_TICK_IN_FLIGHT } = await import('../src/pathExecutor')
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  try {
    class HungForwardExecutor extends NewForwardExecutor {
      async performPerTick (): Promise<boolean | number> {
        return await new Promise(() => {})
      }
    }
    rig.bot.pathfinder.setExecutor(Forward, HungForwardExecutor)
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    let ticks = 0
    rig.bot.on('physicsTick', () => { ticks++ })
    await assert.rejects(withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(8, 64, 0)), 20000, 'goto hung'), /movement tick went on/)
    assert.ok(ticks >= MAX_TICK_IN_FLIGHT, `${ticks} ticks`)
    // the pathfinder takes the next goto
    rig.bot.pathfinder.setExecutor(Forward, NewForwardExecutor)
    await withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(3, 64, 0)), 20000, 'the next goto hung')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto\'s end waits for the bot to come to rest a bounded number of ticks (a bot in a current, on a ladder, pushed by a mob never does)', async () => {
  const { ThePathfinder } = await import('../src/ThePathfinder')
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  try {
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    await rig.bot.waitForTicks(2)
    // the bot keeps moving (as the physics has it, whatever the controls)
    const entity: any = rig.bot.entity
    Object.defineProperty(entity, 'velocity', { configurable: true, get: () => new Vec3(0.05, 0, 0), set: () => {} })
    let ticks = 0
    rig.bot.on('physicsTick', () => { ticks++ })
    await withTimeout(rig.bot.pathfinder.cleanupBot(true), 10000, 'cleanupBot waited for the bot to stop for good')
    assert.ok(ticks < 2 * (ThePathfinder as any).MAX_SETTLE_TICKS, `${ticks} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})
