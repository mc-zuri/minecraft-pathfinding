import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals, GoalNotReachedError } from '../src'
import type { ExclusionArea } from '../src'
import { COST_INF } from '../src/mineflayer-specific/movements/costs'
import { createCacheWorld } from './setup'

// goto ends short of its goal when its search finds no way on (no path, a timeout no nearer) or its walk ends where the
// goal doesn't hold: it rejected with nothing then, the bot wherever it got to. A room of leaves under spawn protection
// (the survival's square kept out of the breaks), the goal inside: 'the walk by hand ended with resolved, 0 moves
// failed', the bot outside the room, on 1.21.11 and 26.3 real servers. A goto called off (cancel, a new goto) still
// ends quietly.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** a hollow room of leaves from (5, 64, -2) to (9, 67, 2), too high to jump over; the goal at (7, 65, 0) inside */
function leafRoom (world: any): goals.Goal {
  for (let x = 5; x <= 9; x++) {
    for (let y = 64; y <= 67; y++) {
      for (let z = -2; z <= 2; z++) if (x === 5 || x === 9 || y === 64 || y === 67 || z === -2 || z === 2) world.setBlock(new Vec3(x, y, z), 'oak_leaves')
    }
  }
  return new goals.GoalBlock(7, 65, 0)
}

const inRoom = (p: Vec3): boolean => p.x > 5 && p.x < 9 && p.z > -2 && p.z < 2

/** every dig a break the client predicts and the server puts back 6 ticks later (mineflayer's _isBlockPredicted till then) */
function refusingDigs (bot: any): void {
  const world = bot.world
  const pending = new Set<string>()
  bot._isBlockPredicted = (pos: Vec3) => pending.has(pos.floored().toString())
  bot.dig = async (block: any) => {
    const pos = block.position.clone()
    const stateId = block.stateId
    world.setBlock(pos, 'air')
    pending.add(pos.toString())
    bot.emit('diggingCompleted', bot.blockAt(pos))
    void bot.waitForTicks(6).then(() => { pending.delete(pos.toString()); world.setBlock(pos, stateId) })
  }
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: goto to a room of leaves whose breaks are kept out (spawn protection) rejects GoalNotReachedError, the bot outside (before: resolved)`, async () => {
    // the square about the spawn the server keeps, as the survival's breakRefused puts it in exclusionAreasBreak
    const refused: ExclusionArea = (block) => (block.position.x >= 4 && block.position.x <= 10 && block.position.z >= -3 && block.position.z <= 3 ? COST_INF : 0)
    const rig = createCacheWorld(version, 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({ moveSettings: { exclusionAreasBreak: [refused] } } as any))
    const bot: any = rig.bot
    try {
      const goal = leafRoom(bot.world)
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      let finished = 0
      bot.on('goalFinished', () => { finished++ })
      const err: any = await withTimeout(bot.pathfinder.goto(goal).then(() => null, (e: unknown) => e), 60000, 'goto went on for good')
      assert.ok(err instanceof GoalNotReachedError, `goto ended with ${String(err?.message ?? err)} at ${bot.entity.position}`)
      assert.equal(err.code, 'GOAL_NOT_REACHED')
      assert.equal(err.goal, goal)
      // (its search's end: no way in, or no nearer in the time it has)
      assert.ok(['noPath', 'timeout'].includes(err.reason), err.reason)
      assert.match(err.message, /short of the goal \(the search ended: (noPath|timeout)/)
      assert.ok(!inRoom(bot.entity.position), `in the room at ${bot.entity.position}`)
      assert.equal(finished, 0, 'goalFinished emitted')
      assert.equal(bot.pathfinder.isPathing, false)
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: goto into a room of leaves whose every break the server puts back rejects, the bot outside`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    try {
      const goal = leafRoom(bot.world)
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      refusingDigs(bot)
      const err: any = await withTimeout(bot.pathfinder.goto(goal).then(() => null, (e: unknown) => e), 60000, 'goto went on for good')
      assert.ok(err instanceof Error, `goto resolved at ${bot.entity.position}`)
      assert.match(err.message, /came back after 3 digs/)
      assert.ok(!inRoom(bot.entity.position), `in the room at ${bot.entity.position}`)
      for (let y = 64; y <= 67; y++) assert.equal(bot.blockAt(new Vec3(5, y, 0)).name, 'oak_leaves')
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: goto that gets to its goal resolves; one called off (cancel) on the way resolves too, short of it`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    try {
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      const goal = new goals.GoalBlock(6, 64, 0)
      await withTimeout(bot.pathfinder.goto(goal), 30000, 'goto went on for good')
      assert.ok(bot.pathfinder.goalHolds(goal), `ended at ${bot.entity.position}`)

      const far = new goals.GoalBlock(40, 64, 0)
      const goto = bot.pathfinder.goto(far)
      const start = bot.entity.position.clone()
      await withTimeout((async () => { while (bot.entity.position.distanceTo(start) < 3) await bot.waitForTicks(1) })(), 30000, 'the bot never set off')
      await bot.pathfinder.cancel()
      await withTimeout(goto, 10000, 'goto went on after the cancel')
      assert.ok(!bot.pathfinder.goalHolds(far), `at the goal at ${bot.entity.position}`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
