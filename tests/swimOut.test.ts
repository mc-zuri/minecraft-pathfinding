import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A swimmer at the top of the water climbs out onto a block whose top is a block over the water's surface cell's floor,
// as vanilla's player does: in water against a wall it is lifted out (LivingEntity.travel: horizontalCollision with
// room 0.6 up, a 0.3 rise) while it holds jump at the surface. A 26.3 bot in fresh-z's flooded hole (a 1-wide column 3
// deep, a tunnel's end over a ledge level with the surface) had no path out from the water: 1.21.11's search found
// none, 26.3's dug through the ledge from inside the water.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** fresh-z's hole: water at (0, 64..66, 0) in stone, a tunnel along x at y 67..68 over a ledge at (1, 66, 0) */
async function holeRig (version: string): Promise<any> {
  const rig = createCacheWorld(version, 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  const world = bot.world
  for (let x = -3; x <= 6; x++) for (let z = -3; z <= 3; z++) for (let y = 64; y <= 70; y++) world.setBlock(new Vec3(x, y, z), 'stone')
  for (const y of [64, 65, 66]) world.setBlock(new Vec3(0, y, 0), 'water')
  for (const y of [67, 68]) for (let x = 0; x <= 5; x++) world.setBlock(new Vec3(x, y, 0), 'air')
  // (the blocks' updates settled before the search: one near the path resets it)
  await bot.waitForTicks(4)
  return rig
}

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

const describe = (path: any[]): string => path.map((m: any) => `${m.moveType.constructor.name} ${m.entryPos.toString()}->${m.exitPos.toString()} breaks [${m.toBreak.map((b: any) => b.vec.toString()).join(' ')}]`).join(' | ')

for (const version of ['26.3', '1.21.11']) {
  for (const [where, y] of [['at the surface', 66.2], ['at the bottom', 64.2]] as const) {
    test(`${version}: a swimmer ${where} of a flooded hole climbs out onto the ledge level with the surface (a ForwardJump from the surface's water cell), with nothing dug (fresh-z)`, async () => {
      const rig = await holeRig(version)
      const bot = rig.bot
      try {
        bot.entity.position = new Vec3(0.387, y, 0.5)
        bot.entity.velocity = new Vec3(0, 0, 0)
        const goal = new goals.GoalBlock(5, 67, 0)
        const result = await plan(bot, goal)
        assert.equal(result.status, 'success', describe(result.path))
        assert.deepEqual(result.path.flatMap((m: any) => m.toBreak), [], describe(result.path))
        const out = result.path.find((m: any) => m.exitPos.y === 67)
        assert.equal(out?.moveType?.constructor?.name, 'ForwardJump', describe(result.path))
        assert.equal(Math.floor(out.entryPos.y), 66)

        bot.entity.position = new Vec3(0.387, y, 0.5)
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
}
