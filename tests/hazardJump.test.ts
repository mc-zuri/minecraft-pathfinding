import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A jump up a block with a deadly fall beside it (a pit, the nether's lava sea: Movement.jumpHazard) costs more
// (hazardJumpCost), so that the path goes up somewhere safe when that's a few blocks round; and its run-up is the
// hazard one: the jump pressed only when the simulation lands it over the step, a run-up off the line backed off to
// the start's middle first (ForwardJumpExecutor.hazardRunUp).

/** a step a block up along x = -1 (the high ground west of it), a pit south-east of the step's foot */
function stepWithPit (start: Vec3) {
  const rig = createCacheWorld('1.20.4', 64, start).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  for (let x = -8; x <= -1; x++) for (let z = -8; z <= 8; z++) world.setBlock(new Vec3(x, 64, z), 'stone')
  // the pit: no ground there, down to the void
  for (let x = 0; x <= 4; x++) for (let z = -6; z <= -1; z++) world.setBlock(new Vec3(x, 63, z), 'air')
  return rig
}

test('a jump up a step beside a pit costs more: the path goes up where nothing deadly is beside the jump', async () => {
  const rig = stepWithPit(new Vec3(3.5, 64, 0.5))
  try {
    const pf = rig.bot.pathfinder as any
    assert.equal(pf.defaultMoveSettings.hazardJumpCost > 0, true)
    let result: any
    for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(-3, 65, 0))) result = res.result
    assert.equal(result.status, 'success')
    const jump = result.path.find((m: any) => m.moveType.constructor.name === 'ForwardJump')
    assert.ok(jump != null, 'the path jumps up the step')
    const from = jump.entryPos.floored()
    assert.notEqual(from.z, 0, `the path jumps up from ${from}, beside the pit`)
    const dir = new Vec3(Math.sign(Math.floor(jump.exitPos.x) - from.x), 0, Math.sign(Math.floor(jump.exitPos.z) - from.z))
    assert.equal(jump.moveType.jumpHazard(from, dir), false)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('the hazard cost is a setting: with none the path jumps beside the pit, the shortest way', async () => {
  const rig = stepWithPit(new Vec3(3.5, 64, 0.5))
  try {
    rig.bot.pathfinder.setMoveOptions({ hazardJumpCost: 0 })
    let result: any
    for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(-3, 65, 0))) result = res.result
    const jump = result.path.find((m: any) => m.moveType.constructor.name === 'ForwardJump')
    assert.equal(jump.entryPos.floored().z, 0)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a jump by a pit is pressed only from a run-up on the line, and lands over the step: one off it backs off to the start\'s middle first', async () => {
  const { Move } = await import('../src/mineflayer-specific/move')
  const { ForwardJump } = await import('../src/mineflayer-specific/movements/movementProviders')
  // run-ups at the step from the start (0, 64, 0), going towards the pit (south of the start, -z) as they come
  for (const [px, pz, vx, vz, yaw] of [[0.5, 0.3, -0.2, -0.25, 1.0], [0.7, 0.3, -0.1, -0.25, 0.5], [0.4, 0.2, 0, -0.15, 1.57], [0.5, 0.5, -0.2, -0.2, 0.8]]) {
    const rig = stepWithPit(new Vec3(px, 64, pz))
    const bot: any = rig.bot
    try {
      bot.entity.velocity = new Vec3(vx, 0, vz)
      void bot.look(yaw, 0, true)
      const jumps: Array<{ z: number, vz: number }> = []
      let lowest = 64
      // the bot as the tick starts (before its keys move it): a jump pressed from the start's ground leaves it then
      let before = { z: 0, vz: 0, onGround: false, y: 0 }
      bot.on('physicsTickBegin', () => { before = { z: bot.entity.position.z, vz: bot.entity.velocity.z, onGround: bot.entity.onGround, y: bot.entity.position.y } })
      bot.on('physicsTick', () => {
        lowest = Math.min(lowest, bot.entity.position.y)
        if (before.onGround && before.y < 64.5 && bot.getControlState('jump')) jumps.push({ z: before.z, vz: before.vz })
      })
      const pf = bot.pathfinder
      const provider = new ForwardJump(bot, pf.world, pf.defaultMoveSettings)
      const start = Move.startMove(provider, new Vec3(0.5, 64, 0.5), new Vec3(0, 0, 0), 0)
      const move = Move.fromPrevious(5, new Vec3(-0.5, 65, 0.5), start, provider)
      await pf.perform({ path: [move], status: 'success' }, new goals.GoalBlock(-1, 65, 0))
      const at = bot.entity.position
      assert.ok(lowest >= 64 - 1e-6, `the bot fell (to ${lowest.toFixed(2)})`)
      assert.deepEqual([Math.floor(at.x), at.y, Math.floor(at.z)], [-1, 65, 0], `the jump from ${px}, ${pz} ended at ${at}`)
      assert.ok(jumps.length > 0)
      for (const j of jumps) assert.ok(Math.abs(j.z - 0.5) <= 0.25 + 1e-6 && Math.abs(j.vz) <= 0.1 + 1e-6, `from ${px}, ${pz} the jump was pressed off the line: z ${j.z.toFixed(3)}, going ${j.vz.toFixed(3)} across`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})

test('a deadly fall beside a jump: lava or fire, or no ground within a safe drop; a drop of 4 onto stone (a block over maxDropDown, as the jump starts a block up), or into water, is none', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    const pf = rig.bot.pathfinder as any
    // (an executor's look at the world: a provider's is the search's block cache)
    const jump = [...pf.movements.values()].find((e: any) => e.constructor.name === 'NewForwardJumpExecutor')
    const at = new Vec3(0, 64, 0)
    assert.equal(jump.deadlyFall(at, 0, 0, 1), false, 'flat ground')
    world.setBlock(new Vec3(0, 63, 1), 'lava')
    assert.equal(jump.deadlyFall(at, 0, 0, 1), true, 'lava')
    world.setBlock(new Vec3(0, 63, 1), 'air')
    for (let y = 61; y <= 62; y++) world.setBlock(new Vec3(0, y, 1), 'air')
    world.setBlock(new Vec3(0, 60, 1), 'stone')
    assert.equal(jump.deadlyFall(at, 0, 0, 1), false, 'a drop of 4 to stand on (maxDropDown 3, a block more for the jump)')
    world.setBlock(new Vec3(0, 60, 1), 'air')
    assert.equal(jump.deadlyFall(at, 0, 0, 1), true, 'no ground')
    world.setBlock(new Vec3(0, 60, 1), 'water')
    assert.equal(jump.deadlyFall(at, 0, 0, 1), false, 'water')
    world.setBlock(new Vec3(0, 64, 1), 'fire')
    assert.equal(jump.deadlyFall(at, 0, 0, 1), true, 'fire')
  } finally {
    rig.stopPassivePhysics()
  }
})
