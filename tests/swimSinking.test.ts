import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals, PathfinderSinkingError } from '../src'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { Diagonal, Forward, ForwardJump, StraightUp } from '../src/mineflayer-specific/movements/movementProviders'
import { createCacheWorld } from './setup'

// A bot under water in the open sea: its path's moves start where it is, sinking, and swim at their own levels. The
// executors let the bot sink under them (a Forward's or Diagonal's start let go of jump, a StraightUp's failed the
// tick the bot sank a hair under its start), each failed 'bot is too low', and each search from the bot sinking on
// planned the same again: a 1.21.11 bot in a kelp sea failed 6 moves in a row from y 62 down to 54 and drowned
// (f1-grim, t108690). A move that still fails so in the water hands back at once (PathfinderSinkingError), for the
// caller to take the bot up for air, not search again under water.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** a sea from x -8 to 8 (z -8..8), its water y 54..62 (the surface cell at 62) over stone, the shore at x 9 on */
async function seaRig (version: string, executor?: any) {
  const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  for (let x = -8; x <= 14; x++) {
    for (let z = -8; z <= 8; z++) {
      for (let y = 53; y <= 63; y++) bot.world.setBlock(new Vec3(x, y, z), x <= 8 ? (y === 53 ? 'stone' : y <= 62 ? 'water' : 'air') : (y <= 62 ? 'stone' : 'air'))
    }
  }
  if (executor != null) {
    for (const provider of [Forward, Diagonal, ForwardJump, StraightUp]) bot.pathfinder.setExecutor(provider, executor)
  }
  await bot.waitForTicks(4)
  return { rig, bot }
}

for (const version of ['1.21.11', '26.3']) {
  test(`${version}: a bot sinking under the sea swims its path to the shore, no move failed 'too low' (f1-grim)`, async () => {
    const { rig, bot } = await seaRig(version)
    const failed: string[] = []
    bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
    try {
      bot.entity.position = new Vec3(-2.5, 59.4, 0.5)
      bot.entity.velocity = new Vec3(0, -0.025, 0)
      const goal = new goals.GoalBlock(11, 63, 0)
      await withTimeout(bot.pathfinder.goto(goal), 30000, `goto timed out at ${bot.entity.position}`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed.filter(f => /too low/.test(f)), [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

for (const version of ['1.21.11', '26.3']) {
  test(`${version}: moves that set no jump in the water (Forward, Diagonal, ForwardJump and StraightUp all run so) still swim their moves at the moves' level (the runner holds jump under the exit plus 0.6, as Baritone's Movement.update), and the bot gets out of the sea`, async () => {
    // the moves' own keys: forward toward the exit, no jump (the old water starts let go of it)
    class NoJump extends NewForwardExecutor {
      private steer (thisMove: any): void {
        const d = thisMove.exitPos.minus(this.bot.entity.position)
        void this.bot.look(Math.atan2(-d.x, -d.z), 0, true)
        this.bot.clearControlStates()
        this.bot.setControlState('forward', true)
      }

      override async align (thisMove: any): Promise<boolean> { this.steer(thisMove); return true }
      override async performInit (): Promise<void> {}
      override async performPerTick (thisMove: any): Promise<boolean> {
        this.steer(thisMove)
        return this.isComplete(thisMove)
      }
    }
    const { rig, bot } = await seaRig(version, NoJump)
    const failed: string[] = []
    bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
    try {
      bot.entity.position = new Vec3(-2.5, 57.4, 0.5)
      bot.entity.velocity = new Vec3(0, -0.025, 0)
      const goal = new goals.GoalBlock(11, 63, 0)
      await withTimeout(bot.pathfinder.goto(goal), 40000, `goto timed out at ${bot.entity.position}`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed.filter(f => /too low/.test(f)), [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('a swimmer held more than a block under its move for SINK_TICKS (its jump no match for what takes it down) ends goto with PathfinderSinkingError, the keys let go', async () => {
  // a move that dives (sneak: LocalPlayer.aiStep's goDownInWater), the runner's jump hold off
  class Dives extends NewForwardExecutor {
    override async align (): Promise<boolean> { return true }
    override async performInit (): Promise<void> {}
    override isAlreadyCompleted (): boolean { return false }
    override async performPerTick (): Promise<boolean> {
      this.bot.clearControlStates()
      this.bot.setControlState('sneak', true)
      return false
    }

    override holdJumpInLiquid (): void {}
  }
  const { rig, bot } = await seaRig('1.21.11', Dives)
  const failed: string[] = []
  bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
  try {
    bot.entity.position = new Vec3(-2.5, 55.9, 0.5)
    bot.entity.velocity = new Vec3(0, 0, 0)
    let err: any = null
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(11, 63, 0)), 30000, `goto timed out at ${bot.entity.position}`).catch((e: any) => { err = e })
    assert.ok(err instanceof PathfinderSinkingError, `goto ended with ${String(err)} (${failed.join(' | ')})`)
    assert.equal(err.code, 'PATHFINDER_SINKING')
    assert.ok(failed.length <= 1, failed.join(' | '))
    assert.equal(bot.pathfinder.isPathing, false)
    assert.deepEqual(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k)), [])
  } finally {
    rig.stopPassivePhysics()
  }
})

for (const version of ['1.21.11', '26.3']) {
  test(`${version}: a bot sinking in a flooded shaft swims its StraightUp moves up, none failed the tick it sank a hair under its start (f1-grim: 'StraightUp: too low')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    // a shaft a block wide at (0, z 0) in stone, water from y 54 up to the floor's cell (63), the feet on the ground
    // round its mouth at 64
    for (let x = -2; x <= 3; x++) for (let z = -2; z <= 2; z++) for (let y = 53; y <= 63; y++) bot.world.setBlock(new Vec3(x, y, z), x === 0 && z === 0 && y >= 54 ? 'water' : 'stone')
    await bot.waitForTicks(4)
    const failed: string[] = []
    bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
    try {
      bot.entity.position = new Vec3(0.5, 57.62, 0.5)
      bot.entity.velocity = new Vec3(0, -0.025, 0)
      const goal = new goals.GoalBlock(2, 64, 0)
      await withTimeout(bot.pathfinder.goto(goal), 30000, `goto timed out at ${bot.entity.position}`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed, [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
