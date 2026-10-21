import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A tower's StraightUp from a cell of water: its block goes into the cell the bot swims in, and a swimmer's feet never
// get over it to let the block in (LivingEntity.aiStep: in water deeper than the jump threshold, 0.4, a jump is
// jumpInLiquid's 0.04 a tick, not jumpFromGround's 0.42; the bot bobs at the surface, its box in the cell). The place
// failed 'Invalid placement' (the bot's box in the block's cell) at each try: a 26.3 bot in a pool a block deep at
// (-258, 64, -102) bobbed up to 64.96 and no higher (f9-26.3 t105350).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

const describe = (path: any[]): string => path.map((m: any) => `${m.moveType.constructor.name} ${m.entryPos.toString()}->${m.exitPos.toString()} places [${m.toPlace.map((p: any) => p.vec.toString()).join(' ')}]`).join(' | ')

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: no tower is planned from a cell of water (its block would go into the cell the swimmer bobs in); the way up is from the pool's rim (f9-26.3: 'Invalid placement')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    const bot: any = rig.bot
    bot.inventory.items = () => [{ type: bot.registry.itemsByName.dirt.id, count: 16, name: 'dirt', slot: 36 }]
    bot.loadPlugin(createPlugin({ moveSettings: { scaffoldReserve: 0 } as any }))
    // a pool a block deep (y 64) from x -2 to 2, its rim the floor's level with the surface (stone at y 64 round it)
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) bot.world.setBlock(new Vec3(x, 64, z), 'water')
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) bot.world.setBlock(new Vec3(x, 64, z), 'stone')
    await bot.waitForTicks(4)
    try {
      bot.entity.position = new Vec3(0.5, 64.2, 0.5)
      bot.entity.velocity = new Vec3(0, 0, 0)
      // over the pool's middle, two blocks over its surface
      const goal = new goals.GoalBlock(0, 66, 0)
      let final: any
      for await (const res of bot.pathfinder.getPathTo(goal)) final = res
      const path = final.result.path
      assert.equal(final.result.status, 'success', describe(path))
      const inWater = path.filter((m: any) => m.toPlace.some((p: any) => bot.blockAt(p.vec)?.name === 'water' && Math.floor(m.entryPos.x) === p.x && Math.floor(m.entryPos.z) === p.z && Math.floor(m.entryPos.y) === p.y))
      assert.deepEqual(inWater.map((m: any) => m.moveType.constructor.name), [], describe(path))

      const failed: string[] = []
      bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
      await withTimeout(bot.pathfinder.goto(goal), 40000, `goto timed out at ${bot.entity.position} (${failed.join(' | ')})`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed.filter(f => /Invalid placement/.test(f)), [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
