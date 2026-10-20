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
  test("a Forward move whose alignment never holds is failed once the bot ran 2 blocks off its way, and goto goes on from there (full-26.3-fresh-o: forward and sprint held 15 blocks on, past the path's turn and off a 31-block cliff)", async () => {
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
      assert.ok(failures.some(f => /ran off the move/.test(f)), failures.join(' | '))
      // (each new path's first move run off again, 2 blocks and the stop's slide, before the diagonals back)
      assert.ok(off < 6, `${off.toFixed(1)} blocks off the path`)
      assert.ok(past < 13, `ran on to x ${past.toFixed(1)}`)
    } finally {
      rig.bot.off('physicsTick', onTick)
      rig.bot.off('pathfinderMoveFailed', onFail)
      rig.stopPassivePhysics()
    }
  })
}
