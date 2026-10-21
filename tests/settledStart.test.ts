import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { predictLanding } from '../src/mineflayer-specific/edgeGuard'
import { createCacheWorld } from './setup'

// goto's search starts where the bot comes to rest with its keys let go (predictLanding), not where it is in the air:
// a 26.3 bot's path made at the top of a swimmer's bob out of a flooded hole's water (y 38.16, the surface cell at 37)
// started in the air over the water, and its first move failed 'bot is too low' as the bot sank back (full-26.3-fresh-z).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

/** the bot put at `pos` with `vel`, in the air (the physics' next tick sees it so) */
function putInAir (bot: any, pos: Vec3, vel: Vec3): void {
  bot.entity.position = pos
  bot.entity.velocity = vel
  bot.entity.onGround = false
  bot.entity.isInWater = false
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: a path made at the top of a swimmer's bob out of a flooded hole starts in the water's surface cell, and goto climbs out with no move failed (fresh-z)`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const world = bot.world
    try {
      // fresh-z's hole: water at (0, 64..66, 0) in stone, a tunnel along x at y 67..68 over a ledge at (1, 66, 0)
      for (let x = -3; x <= 6; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 70; y++) world.setBlock(new Vec3(x, y, z), 'stone')
      for (const y of [64, 65, 66]) world.setBlock(new Vec3(0, y, 0), 'water')
      for (const y of [67, 68]) for (let x = 0; x <= 5; x++) world.setBlock(new Vec3(x, y, 0), 'air')
      await bot.waitForTicks(4)

      const goal = new goals.GoalBlock(5, 67, 0)
      putInAir(bot, new Vec3(0.387, 67.159, 0.5), new Vec3(0, 0, 0))
      const landing = predictLanding(bot)
      assert.ok(landing != null && Math.floor(landing.y) === 66, `lands at ${landing?.toString()}`)
      const result = await plan(bot, goal)
      assert.equal(result.status, 'success')
      assert.equal(Math.floor(result.path[0].entryPos.y), 66, `the path starts at ${result.path[0].entryPos.toString()}`)

      putInAir(bot, new Vec3(0.387, 67.159, 0.5), new Vec3(0, 0, 0))
      const failed: string[] = []
      bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
      await withTimeout(bot.pathfinder.goto(goal), 30000, `goto timed out at ${bot.entity.position}`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed, [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('a path made mid-jump starts on the ground the jump comes down on, one made on the ground where the bot stands', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  try {
    await bot.waitForTicks(2)
    const goal = new goals.GoalBlock(6, 64, 0)
    // a jump's rise, a block and a bit over the flat ground (y 64)
    putInAir(bot, new Vec3(0.5, 65.1, 0.5), new Vec3(0, 0.2, 0))
    const landing = predictLanding(bot)
    assert.ok(landing != null && landing.y === 64, `lands at ${landing?.toString()}`)
    let result = await plan(bot, goal)
    assert.equal(result.status, 'success')
    assert.equal(result.path[0].entryPos.y, 64, `the path starts at ${result.path[0].entryPos.toString()}`)

    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.velocity = new Vec3(0, 0, 0)
    bot.entity.onGround = true
    assert.equal(predictLanding(bot), null)
    result = await plan(bot, goal)
    assert.equal(result.path[0].entryPos.toString(), new Vec3(0.5, 64, 0.5).toString())
  } finally {
    rig.stopPassivePhysics()
  }
})
