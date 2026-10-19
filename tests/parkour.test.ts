import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'
import { BotcraftPhysics, ControlStateHandler, EPhysicsCtx } from '@nxg-org/mineflayer-physics-util'

import { createPlugin, goals } from '../src'
import { Move } from '../src/mineflayer-specific/move'
import { ParkourDiagonal } from '../src/mineflayer-specific/movements/movementProviders'
import { JumpSim } from '../src/mineflayer-specific/movements/simulators/jumpSim'
import { stateLookAt } from '../src/mineflayer-specific/movements/movementUtils'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** runs one move of the given type from the bot's position (perform on a path of that move alone) */
async function runMove (rig: any, Provider: any, entry: Vec3, exit: Vec3, cost: number): Promise<{ ticks: number, failed: string[] }> {
  const bot = rig.bot
  const provider = new Provider(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
  const move = Move.fromPrevious(cost, exit, Move.startMove(provider, entry, new Vec3(0, 0, 0), 1000), provider)
  const failed: string[] = []
  bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info?.error)))
  let ticks = 0
  bot.on('physicsTick', () => { ticks++ })
  const goal = new goals.GoalBlock(Math.floor(exit.x), Math.floor(exit.y), Math.floor(exit.z))
  await withTimeout(bot.pathfinder.perform({ path: [move], status: 'success' }, goal), 20000, `timed out at ${bot.entity.position}`)
  return { ticks, failed }
}

test('a simulation made from the bot goes the way its controller turns it, not the way the bot faces', () => {
  const rig = createCacheWorld('1.20.4', 65, new Vec3(0.5, 65, 0.5)).rig
  try {
    const bot: any = rig.bot
    // facing +z (south), the look mineflayer keeps in float degrees (bot.entity.yawDegrees)
    void bot.look(0, 0, true)
    void bot.look(Math.PI, 0, true)
    assert.ok(bot.entity.yawDegrees != null)
    const sim = new JumpSim(new BotcraftPhysics(bot.registry), bot.pathfinder?.world ?? (bot as any).world)
    const ctx = EPhysicsCtx.FROM_BOT(sim.ctx, bot)
    ctx.state.control = ControlStateHandler.DEFAULT()
    ctx.state.control.set('forward', true)
    // a point to the north (-z)
    const target = new Vec3(0.5, 65, -10.5)
    sim.simulateUntil(() => false, () => {}, (state) => stateLookAt(state, target), ctx, (bot as any).world, 10)
    // it walked north, toward the point: the engine moves the player by the float degrees, which the look turned too
    assert.ok(ctx.state.pos.z < 0, `at ${ctx.state.pos}`)
    assert.ok(Math.abs(ctx.state.pos.x - 0.5) < 0.01, `at ${ctx.state.pos}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a ParkourDiagonal down over a one-deep hole, the bot facing the step behind it, goes over: the jump\'s simulations turn the way the jump goes', async () => {
  const rig = createCacheWorld('1.20.4', 65, new Vec3(0.5, 66, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // a ledge one high along x at z 0 (stone at y 65), a step up behind it at z 1 (y 65 and 66), the ground below at y
    // 64: from (0, 66, 0) two over and two along to (2, 65, -2), over (1, 65, -1), a cell one deep (a play run's on
    // 26.3, seed 7)
    for (let x = -3; x <= 3; x++) {
      world.setBlock(new Vec3(x, 65, 0), 'stone')
      world.setBlock(new Vec3(x, 65, 1), 'stone')
      world.setBlock(new Vec3(x, 66, 1), 'stone')
    }
    // standing on the ledge, just landed, facing the step (south): the simulations went south too and found no way
    // (no jump now, none from the edge, nor falling off it), and the bot backed up into the step until the move failed
    rig.bot.entity.position = new Vec3(0.495, 66, 0.206)
    rig.bot.entity.velocity = new Vec3(-0.0043, -0.0784, -0.0189)
    rig.bot.entity.onGround = true
    void rig.bot.look(3.121, 0, true)
    rig.bot.clearControlStates()
    const { ticks, failed } = await runMove(rig, ParkourDiagonal, new Vec3(0.5, 66, 0.5), new Vec3(2.5, 65, -1.5), 13.244)
    const at = rig.bot.entity.position
    assert.deepEqual(failed, [])
    assert.equal(Math.floor(at.x), 2, `at ${at}`)
    assert.equal(Math.floor(at.z), -2, `at ${at}`)
    assert.ok(ticks < 40, `${ticks} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a ParkourDiagonal down into a pit beside the landing walks off the ledge aimed in from the landing\'s corner, not at it: a block next to the corner held the box', async () => {
  const rig = createCacheWorld('1.20.4', 65, new Vec3(0.5, 66, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // a ledge one high (stone at y 65) with the bot on it at (0, 66, 0); below it a cell one deep at (1, 65, 1) and the
    // landing's level (1 to 3, 65, 2 to 3), stone at (2, 65, 1) beside the landing's corner (a dragon run's on 26.3)
    for (let x = -2; x <= 5; x++) {
      for (let z = -2; z <= 5; z++) world.setBlock(new Vec3(x, 65, z), 'stone')
    }
    world.setBlock(new Vec3(1, 65, 1), 'air')
    for (let x = 1; x <= 3; x++) for (let z = 2; z <= 3; z++) world.setBlock(new Vec3(x, 65, z), 'air')
    world.setBlock(new Vec3(-1, 66, 0), 'stone')
    // against the ledge's west wall: walked off it toward the landing's corner (2, 2) the bot came down in the open
    // cells at (1, 2) and pressed into the stone at (2, 65, 1), its box half beside the landing; the fall's simulation
    // did the same and never landed, and with no jump either the move failed ('will not make this jump')
    rig.bot.entity.position = new Vec3(0.3, 66, 0.698)
    rig.bot.entity.velocity = new Vec3(0, -0.0784, 0)
    rig.bot.entity.onGround = true
    void rig.bot.look(1.573, 0, true)
    rig.bot.clearControlStates()
    const { ticks, failed } = await runMove(rig, ParkourDiagonal, new Vec3(0.5, 66, 0.5), new Vec3(2.5, 65, 2.5), 13.244)
    const at = rig.bot.entity.position
    assert.deepEqual(failed, [])
    assert.equal(Math.floor(at.x), 2, `at ${at}`)
    assert.equal(Math.floor(at.z), 2, `at ${at}`)
    assert.ok(ticks < 40, `${ticks} ticks`)
  } finally {
    rig.stopPassivePhysics()
  }
})
