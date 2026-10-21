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

{
  const yaw = 0
  test("a Forward move whose alignment never holds is failed once the bot ran 3 blocks off its way (RAN_PAST, as Baritone's PathExecutor at once past MAX_MAX_DIST_FROM_PATH), and goto goes on from there (full-26.3-fresh-o: forward and sprint held 15 blocks on, past the path's turn and off a 31-block cliff)", async () => {
    const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
    // the move that never lines up: landAlign holds forward and sprint along the yaw the bot has, no look at the move
    class NeverAligned extends NewForwardExecutor {
      public isInitAligned (): boolean { return false }
      isAlreadyCompleted (): boolean { return false }
      override async align (thisMove: any, tickCount: number, goal: any): Promise<boolean> {
        rig.bot.entity.yaw = yaw
        return await super.align(thisMove, tickCount, goal)
      }
    }
    rig.bot.pathfinder.setExecutor(Forward, NeverAligned)
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    let off = 0
    let past = 0
    const failures: string[] = []
    const onTick = (): void => {
      off = Math.max(off, Math.abs(rig.bot.entity.position.z - 0.5))
      past = Math.max(past, rig.bot.entity.position.x)
    }
    const onFail = (info: any): void => { failures.push(String(info.error)) }
    rig.bot.on('physicsTick', onTick)
    rig.bot.on('pathfinderMoveFailed', onFail)
    try {
      await withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(10, 64, 0)), 30000, `goto timed out at ${rig.bot.entity.position.toString()}`)
      assert.ok(failures.some(f => /ran off the move|off the path/.test(f)), failures.join(' | '))
      // (each new path's first move run off again, 2 blocks and the stop's slide, before the diagonals back)
      assert.ok(off < 8, `${off.toFixed(1)} blocks off the path`)
      assert.ok(past < 13, `ran on to x ${past.toFixed(1)}`)
    } finally {
      rig.bot.off('physicsTick', onTick)
      rig.bot.off('pathfinderMoveFailed', onFail)
      rig.stopPassivePhysics()
    }
  })
}

test('a move that swings 2.5 blocks off its way and back (a swim\'s drift, a detour round a mob) isn\'t failed: off the path is past OFF_PATH_DIST for OFF_PATH_TICKS, or past OFF_PATH_MAX_DIST at once (Baritone\'s PathExecutor; it failed at 2 blocks)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ optimizers: new Map() } as any))
  let ticks = 0
  // the first move's walk: 2.5 blocks to the side for a while, then on to its exit
  class Swings extends NewForwardExecutor {
    override async align (): Promise<boolean> { return true }
    override async performInit (): Promise<void> {}
    override isAlreadyCompleted (): boolean { return false }
    override async performPerTick (thisMove: any): Promise<boolean> {
      // (the Forward executor's own check of its way, as its perform has it)
      this.throwIfRanPast(thisMove)
      const pos = this.bot.entity.position
      const aside = ++ticks < 40 && thisMove.exitPos.x < 2
      const to = aside ? new Vec3(thisMove.exitPos.x, 64, 3) : thisMove.exitPos
      void this.bot.look(Math.atan2(-(to.x - pos.x), -(to.z - pos.z)), 0, true)
      this.bot.setControlState('forward', pos.xzDistanceTo(to) > 0.3)
      return !aside && pos.xzDistanceTo(thisMove.exitPos) < 0.3
    }
  }
  rig.bot.pathfinder.setExecutor(Forward, Swings)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  const failures: string[] = []
  rig.bot.on('pathfinderMoveFailed', (info: any) => failures.push(String(info.error)))
  let off = 0
  rig.bot.on('physicsTick', () => { off = Math.max(off, rig.bot.entity.position.z - 0.5) })
  try {
    await withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(4, 64, 0)), 30000, `goto timed out at ${rig.bot.entity.position.toString()}`)
    assert.ok(off > 2.2, `only ${off.toFixed(1)} off`)
    assert.deepEqual(failures, [])
  } finally {
    rig.stopPassivePhysics()
  }
})
