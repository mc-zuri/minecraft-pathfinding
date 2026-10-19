import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Optimizer } from '../src/mineflayer-specific/post'
import { createCacheWorld } from './setup'

// A ForwardJump up a step, with the moves after it on the step merged into one (ForwardJumpUpOpt), runs as one move
// steered straight at the far end, from the jump's start. On a 26.3 nether run (seed of run t, at (-258, 46, -81)) the
// path jumped west onto a step and went on south-west along it, the straight line cut across the corner of a pit
// beside the step, and the bot jumped while turning, slid off the step's side into the pit and down to the lava sea
// ('ForwardJumpMove: too low (1)', dead). 140 of 177 ForwardJumps that failed on the nether runs were merged ones.

/** the run's ground, shifted: the start block at (0, 64, 0), the step a block up west of it, the pit south-east */
function stepByPit (start: Vec3) {
  const rig = createCacheWorld('1.20.4', 64, start).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  // the pit: no ground south of the start and the step's east end (nothing under it, down to the void)
  for (let x = -2; x <= 12; x++) for (let z = -12; z <= -1; z++) if (z <= -2 || x >= -1) world.setBlock(new Vec3(x, 63, z), 'air')
  // the step's ground, a block up: west of the start and on south-west along the pit's edge
  const up: Array<[number, number]> = []
  for (let x = -8; x <= -1; x++) up.push([x, 0], [x, 1])
  for (let x = -8; x <= 0; x++) up.push([x, 2])
  for (let x = -8; x <= -2; x++) up.push([x, -1], [x, -2])
  for (let x = -8; x <= -3; x++) up.push([x, -3], [x, -4])
  for (const [x, z] of up) world.setBlock(new Vec3(x, 64, z), 'stone')
  for (let x = -8; x <= -3; x++) for (const z of [-3, -4]) world.setBlock(new Vec3(x, 63, z), 'stone')
  for (const z of [-1, -2]) world.setBlock(new Vec3(-2, 63, z), 'stone')
  return rig
}

test('a jump up a step is not merged with the moves after it over a line that leaves the step\'s ground (a pit beside it)', async () => {
  const rig = stepByPit(new Vec3(4.5, 64, 0.5))
  try {
    let result: any
    for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(-4, 65, -3))) result = res.result
    assert.equal(result.status, 'success')
    const path = result.path
    const jumpAt = path.findIndex((m: any) => m.moveType.constructor.name === 'ForwardJump')
    assert.ok(jumpAt >= 0, 'the path jumps up the step')
    assert.ok(path.slice(jumpAt + 1).some((m: any) => m.moveType.constructor.name === 'Diagonal'), 'and goes on along it')

    const optimizer = new Optimizer(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.getActiveMappings().optimizers)
    optimizer.loadPath(path)
    const runs = await optimizer.compute()
    const jump = runs.find((m: any) => m.moveType.constructor.name === 'ForwardJump')
    assert.ok(jump != null)
    // the jump ends on the step: steered from its start at the third diagonal, it went over the pit
    assert.deepEqual(jump.exitPos.toArray(), [-0.5, 65, 0.5], `the jump was merged on to ${jump.exitPos}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto up a step beside a pit gets there without falling in, whichever way the bot runs up to it', async () => {
  for (const [x, z] of [[4, 0], [3, 1], [2, 0], [5, 2]]) {
    const rig = stepByPit(new Vec3(x + 0.5, 64, z + 0.5))
    try {
      let lowest = rig.bot.entity.position.y
      rig.bot.on('physicsTick', () => { lowest = Math.min(lowest, rig.bot.entity.position.y) })
      const goal = new goals.GoalBlock(-4, 65, -3)
      await rig.bot.pathfinder.goto(goal).catch(() => {})
      const at = rig.bot.entity.position
      assert.ok(lowest >= 64 - 1e-6, `from ${x}, ${z} the bot fell into the pit (to y ${lowest.toFixed(1)})`)
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `from ${x}, ${z} goto ended at ${at}`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})
