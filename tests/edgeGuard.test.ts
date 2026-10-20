import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Forward } from '../src/mineflayer-specific/movements/movementProviders'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { CancelError } from '../src/mineflayer-specific/exceptions'
import { MovementOptimizer } from '../src/mineflayer-specific/post'
import { predictEdgeFall } from '../src/mineflayer-specific/edgeGuard'
import { createCacheWorld } from './setup'

// The edge guard (EdgeGuard): wherever the bot's keys would take its feet off the ground over a drop deeper than it
// may fall, with no move planning it, the bot sneaks (Player.maybeBackOffFromEdge holds it at the edge) and the move
// fails. Each fault below ran a fake rig's bot off a 30-block cliff before; a 26.3 bot fell 31 off a move that ran on
// (full-26.3-fresh-o), 35 off a bridge on an explore leg (full-26.3-fresh-r), and 6 at 2 health when a failed jump's
// slide went on after the keys were let go (full-26.3-s31337-f).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** the cells of the floor (y 63) cut away, with the ground 30 below them (stone at y 33: a 30-block drop) */
function cliffRig (cut: (x: number, z: number) => boolean, opts: { water?: boolean, start?: Vec3, plugin?: any } = {}) {
  const start = opts.start ?? new Vec3(0.5, 64, 0.5)
  const rig = createCacheWorld('1.20.4', 64, start).rig
  rig.bot.loadPlugin(createPlugin(opts.plugin))
  const world = (rig.bot as any).world
  for (let x = -12; x <= 16; x++) {
    for (let z = -12; z <= 16; z++) {
      if (!cut(x, z)) continue
      world.setBlock(new Vec3(x, 63, z), 'air')
      world.setBlock(new Vec3(x, 33, z), 'stone')
      if (opts.water === true) world.setBlock(new Vec3(x, 34, z), 'water')
    }
  }
  rig.bot.entity.position = start.clone()
  let lowest = Infinity
  const onTick = (): void => { lowest = Math.min(lowest, rig.bot.entity.position.y) }
  rig.bot.on('physicsTick', onTick)
  const failures: string[] = []
  const onFail = (info: any): void => { failures.push(String(info.error)) }
  rig.bot.on('pathfinderMoveFailed', onFail)
  return {
    rig,
    bot: rig.bot as any,
    failures,
    lowest: () => lowest,
    stop: () => {
      rig.bot.off('physicsTick', onTick)
      rig.bot.off('pathfinderMoveFailed', onFail)
      rig.stopPassivePhysics()
    }
  }
}

async function ticks (bot: any, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await bot.waitForTicks(1)
}

/** goto, its failure (a goto the faults give up on) kept */
async function gotoSettled (bot: any, goal: goals.Goal, ms = 20000): Promise<string | null> {
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, `goto timed out at ${String(bot.entity.position)}`)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** a Forward executor that runs on along its move, forward and sprint held, till 2 blocks past its exit */
class RunsOn extends NewForwardExecutor {
  override async align (..._args: any[]): Promise<boolean> { return true }
  override async performInit (): Promise<void> {}
  override isAlreadyCompleted (): boolean { return false }
  override async performPerTick (thisMove: any, ..._args: any[]): Promise<boolean> {
    const dir = thisMove.exitPos.minus(thisMove.entryPos)
    const pos = this.bot.entity.position
    const past = (pos.x - thisMove.exitPos.x) * dir.x + (pos.z - thisMove.exitPos.z) * dir.z
    void this.bot.look(Math.atan2(-dir.x, -dir.z), 0, true)
    this.bot.setControlState('forward', true)
    this.bot.setControlState('sprint', true)
    return past > 2
  }
}

/**
 * A Forward executor that runs on at +x, sneaks at the cliff's edge (x 5) and, held there a few ticks, fails its move
 * (a CancelError, the keys let go: the sneak's hold with them), as a ParkourForward did ('will not make this jump!',
 * full-26.3-s31337-f); the moves after are NewForwardExecutor's own
 */
class FailsAtEdge extends RunsOn {
  static failed = false
  private held = 0
  override async align (thisMove: any, tickCount: number, goal: any): Promise<boolean> {
    return FailsAtEdge.failed ? await NewForwardExecutor.prototype.align.call(this, thisMove, tickCount, goal) : true
  }

  override async performPerTick (thisMove: any, ...args: any[]): Promise<boolean> {
    if (FailsAtEdge.failed) return await (NewForwardExecutor.prototype as any).performPerTick.call(this, thisMove, ...args)
    if (this.bot.entity.position.x > 4.9) {
      this.bot.setControlState('sneak', true)
      if (++this.held > 5) {
        FailsAtEdge.failed = true
        throw new CancelError('a move failed at the edge')
      }
    }
    return await super.performPerTick(thisMove)
  }
}

for (const guard of ['auto', 'off'] as const) {
  const falls = guard === 'off'
  test(`a move that runs on past its end at a cliff's edge ${falls ? 'falls off with the guard off' : 'is held at the edge and fails'}`, async () => {
    const c = cliffRig((x) => x >= 4, { start: new Vec3(-5.5, 64, 0.5), plugin: { pathfinderSettings: { edgeGuard: guard }, optimizers: new Map() } })
    try {
      c.bot.pathfinder.setExecutor(Forward, RunsOn)
      await gotoSettled(c.bot, new goals.GoalBlock(3, 64, 0))
      await ticks(c.bot, 10)
      if (falls) {
        assert.ok(c.lowest() < 60, `the bot never fell (lowest ${c.lowest()})`)
        return
      }
      assert.ok(c.lowest() > 63.9, `the bot fell to ${c.lowest().toFixed(1)}`)
      assert.ok(c.bot.pathfinder.edgeGuard.catches > 0)
      assert.ok(c.failures.some(f => /edge guard/.test(f)), c.failures.join(' | '))
    } finally {
      c.stop()
    }
  })

  test(`a move that fails at a cliff's edge ${falls ? 'leaves the bot to slide off with the guard off' : 'leaves the bot held there'}`, async () => {
    // a ledge one block wide along z 0 to x 4, then along x 4 to z 12, over a 30-deep drop: the move fails at its end
    // and goto searches again for the turn, the keys let go
    const c = cliffRig((x, z) => !((z === 0 && x <= 4) || (x === 4 && z >= 0)), { start: new Vec3(-5.5, 64, 0.5), plugin: { pathfinderSettings: { edgeGuard: guard }, optimizers: new Map() } })
    try {
      FailsAtEdge.failed = false
      c.bot.pathfinder.setExecutor(Forward, FailsAtEdge)
      c.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
      await gotoSettled(c.bot, new goals.GoalBlock(4, 64, 12))
      await ticks(c.bot, 10)
      assert.ok(c.failures.some(f => /a move failed at the edge/.test(f)), c.failures.join(' | '))
      if (falls) {
        assert.ok(c.lowest() < 60, `the bot never fell (lowest ${c.lowest()})`)
        return
      }
      assert.ok(c.lowest() > 63.9, `the bot fell to ${c.lowest().toFixed(1)}`)
      assert.ok(c.bot.pathfinder.edgeGuard.catches > 0)
    } finally {
      c.stop()
    }
  })

  test(`a merged line that crosses a gap the path went round ${falls ? 'walks into it with the guard off' : 'is held at its edge'}`, async () => {
    // an L of floor round a 30-deep pit: along z 0 to x 6, then along x 6 to z 6
    const c = cliffRig((x, z) => !((z === 0 && x >= -1 && x <= 6) || (x === 6 && z >= 0 && z <= 6) || (x <= -1)), { plugin: { pathfinderSettings: { edgeGuard: guard } } })
    try {
      // an optimizer that merges every level move into one straight line, whatever it crosses
      class MergesAll extends MovementOptimizer {
        async identEndOpt (currentIndex: number, path: any[]): Promise<number> {
          const y = path[currentIndex].entryPos.y
          let i = currentIndex
          while (i + 1 < path.length && path[i + 1].exitPos.y === y) i++
          return i
        }
      }
      c.bot.pathfinder.setOptimizer(Forward, MergesAll)
      c.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
      await gotoSettled(c.bot, new goals.GoalBlock(6, 64, 6))
      await ticks(c.bot, 10)
      if (falls) {
        assert.ok(c.lowest() < 60, `the bot never fell (lowest ${c.lowest()})`)
        return
      }
      assert.ok(c.lowest() > 63.9, `the bot fell to ${c.lowest().toFixed(1)}`)
      assert.ok(c.bot.pathfinder.edgeGuard.catches > 0)
    } finally {
      c.stop()
    }
  })
}

test('a planned drop of maxDropDown goes on with no catch', async () => {
  const c = cliffRig(() => false)
  const world = c.bot.world
  try {
    // a terrace 3 blocks down from x 3 on
    for (let x = 3; x <= 9; x++) for (let z = -3; z <= 3; z++) {
      for (const y of [61, 62, 63]) world.setBlock(new Vec3(x, y, z), 'air')
      world.setBlock(new Vec3(x, 60, z), 'stone')
    }
    const err = await gotoSettled(c.bot, new goals.GoalBlock(7, 61, 0))
    assert.equal(err, null)
    assert.ok(Math.abs(c.bot.entity.position.y - 61) < 0.01, String(c.bot.entity.position))
    assert.equal(c.bot.pathfinder.edgeGuard.catches, 0)
  } finally {
    c.stop()
  }
})

test('a walk down a staircase of 1-block steps and off a 2-block ledge has no catch (the guard is past maxDropDown only)', async () => {
  const c = cliffRig(() => false, { plugin: { pathfinderSettings: { edgeGuard: 'always' } } })
  const world = c.bot.world
  try {
    // steps down along +x from x 2: one block lower each, to y 59 (stood on at 60) at x 5, then a 2-block drop at x 8
    for (let x = 2; x <= 12; x++) {
      const floor = x >= 8 ? 57 : Math.max(59, 63 - (x - 1))
      for (let z = -3; z <= 3; z++) {
        for (let y = floor + 1; y <= 63; y++) world.setBlock(new Vec3(x, y, z), 'air')
        world.setBlock(new Vec3(x, floor, z), 'stone')
      }
    }
    const err = await gotoSettled(c.bot, new goals.GoalBlock(11, 58, 0))
    assert.equal(err, null)
    assert.ok(Math.abs(c.bot.entity.position.y - 58) < 0.01, String(c.bot.entity.position))
    assert.equal(c.bot.pathfinder.edgeGuard.catches, 0)
    assert.deepEqual(c.failures, [])
  } finally {
    c.stop()
  }
})

for (const mode of ['always', 'auto'] as const) {
  test(`the bot's own keys at a cliff's edge (no goto) ${mode === 'always' ? 'are held there with the guard always on' : 'take it off with the guard on only for goto'}`, async () => {
    const c = cliffRig((x) => x >= 4, { plugin: { pathfinderSettings: { edgeGuard: mode } } })
    try {
      void c.bot.look(-Math.PI / 2, 0, true)
      c.bot.setControlState('forward', true)
      c.bot.setControlState('sprint', true)
      c.bot.setControlState('jump', true)
      await ticks(c.bot, 60)
      if (mode === 'auto') {
        assert.ok(c.lowest() < 60, `the bot never fell (lowest ${c.lowest()})`)
        return
      }
      assert.ok(c.lowest() > 63.9, `the bot fell to ${c.lowest().toFixed(1)}`)
      assert.ok(c.bot.entity.position.x > 3.5, `the bot stopped short at x ${c.bot.entity.position.x.toFixed(2)}`)
      // the keys let go: the sneak the guard put down is let go too
      c.bot.clearControlStates()
      await ticks(c.bot, 20)
      assert.equal(c.bot.getControlState('sneak'), false)
    } finally {
      c.stop()
    }
  })
}

test('a walk off a cliff into deep water is let be, onto stone 30 down caught unless that much is allowed; a suspended guard is off', async () => {
  const c = cliffRig((x) => x >= 4, { water: true, plugin: { pathfinderSettings: { edgeGuard: 'always' } } })
  try {
    const bot = c.bot
    void bot.look(-Math.PI / 2, 0, true)
    // standing at the edge, walking on
    bot.entity.position = new Vec3(4.25, 64, 0.5)
    bot.entity.velocity = new Vec3(0.15, -0.0784, 0)
    bot.entity.onGround = true
    bot.setControlState('forward', true)
    const keys = (await import('@nxg-org/mineflayer-physics-util')).ControlStateHandler.COPY_BOT(bot)
    assert.equal(predictEdgeFall(bot, 3, { controls: keys }), null, 'water 30 down is a landing')
    bot.world.setBlock(new Vec3(4, 34, 0), 'stone')
    bot.world.setBlock(new Vec3(4, 34, 1), 'stone')
    for (let y = 35; y <= 63; y++) bot.world.setBlock(new Vec3(4, y, 0), 'air')
    const fall = predictEdgeFall(bot, 3, { controls: keys })
    assert.ok(fall != null && fall.depth > 20, 'stone 30 down is a fall')
    assert.equal(predictEdgeFall(bot, 40, { controls: keys }), null, 'a fall within the allowed drop is none')
    const release = bot.pathfinder.edgeGuard.suspend()
    assert.equal(bot.pathfinder.edgeGuard.isActive, false)
    release()
    assert.equal(bot.pathfinder.edgeGuard.isActive, true)
  } finally {
    c.stop()
  }
})

test('a walk into a 1-wide shaft with water 30 down, or into an end portal, is let be (the shaft walls are no ground under the fall)', async () => {
  const c = cliffRig(() => false, { plugin: { pathfinderSettings: { edgeGuard: 'always' } } })
  try {
    const bot = c.bot
    // the shaft at (4, z 0): air from y 63 down to water at y 34, stone round it all the way
    for (let y = 34; y <= 63; y++) {
      for (let x = 3; x <= 5; x++) for (let z = -1; z <= 1; z++) bot.world.setBlock(new Vec3(x, y, z), x === 4 && z === 0 ? (y === 34 ? 'water' : 'air') : 'stone')
    }
    bot.world.setBlock(new Vec3(4, 33, 0), 'stone')
    void bot.look(-Math.PI / 2, 0, true)
    bot.entity.velocity = new Vec3(0.15, -0.0784, 0)
    bot.entity.onGround = true
    const { ControlStateHandler } = await import('@nxg-org/mineflayer-physics-util')
    const keys = ControlStateHandler.DEFAULT()
    keys.forward = true
    bot.entity.position = new Vec3(4.25, 64, 0.5)
    assert.equal(predictEdgeFall(bot, 3, { controls: keys }), null)
    bot.world.setBlock(new Vec3(4, 34, 0), 'air')
    assert.ok(predictEdgeFall(bot, 3, { controls: keys }) != null, 'the shaft with no water under it is a fall')
    // an end portal over lava (the stronghold's): the walk into it is the portal's
    bot.world.setBlock(new Vec3(4, 34, 0), 'lava')
    bot.world.setBlock(new Vec3(4, 63, 0), 'end_portal')
    assert.equal(predictEdgeFall(bot, 3, { controls: keys }), null, 'a portal is no fall')
  } finally {
    c.stop()
  }
})

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: a bridge of 10 over a 30-deep gap is built and walked with no fall`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    const Item = require('prismarine-item')(version)
    const stack = new Item(rig.mcData.itemsByName.cobblestone.id, 64)
    stack.slot = 36
    ;(rig.bot.inventory as any).slots[36] = stack
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    for (let x = 1; x <= 10; x++) {
      for (let z = -40; z <= 40; z++) {
        bot.world.setBlock(new Vec3(x, 63, z), 'air')
        bot.world.setBlock(new Vec3(x, 33, z), 'stone')
      }
    }
    let lowest = Infinity
    const onTick = (): void => { lowest = Math.min(lowest, bot.entity.position.y) }
    bot.on('physicsTick', onTick)
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(12, 64, 0)), 40000, `goto timed out at ${String(bot.entity.position)}`)
      assert.ok(lowest > 63.9, `the bot fell to ${lowest.toFixed(1)}`)
      for (let x = 1; x <= 10; x++) assert.equal(bot.blockAt(new Vec3(x, 63, 0))?.name, 'cobblestone', `no block at x ${x}`)
    } finally {
      bot.off('physicsTick', onTick)
      rig.stopPassivePhysics()
    }
  })
}
