import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A bridge's place from a block lower than a full one (a big dripleaf's leaf, a dirt path, soul sand: their tops under
// the node's height): the bot's feet are under the top of the block it places beside its own, and backed over the edge
// to place it, as a bridge is placed, its box is in that block's cell, the place 'Invalid placement' at each try (a
// 1.21.11 bot on a big dripleaf at (-486, 10, 85), its feet at 10.9375, bridging to (-486, 10, 84), f9-1.21.11 t26325).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

const describe = (path: any[]): string => path.map((m: any) => `${m.moveType.constructor.name} ${m.entryPos.toString()}->${m.exitPos.toString()} places [${m.toPlace.map((p: any) => p.vec.toString()).join(' ')}]`).join(' | ')

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: no bridge's place is planned from a block lower than a full one (the bot's box would be in the placed block's cell as it backs over the edge); the way across starts higher, on a block of its own (f9-1.21.11: 'Invalid placement')`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    const bot: any = rig.bot
    bot.inventory.items = () => [{ type: bot.registry.itemsByName.dirt.id, count: 16, name: 'dirt', slot: 36 }]
    bot.loadPlugin(createPlugin({ moveSettings: { scaffoldReserve: 0 } as any }))
    // a corridor along x (z 0) between walls 6 high, shut behind the bot at x -4: the bot on a dirt path (its top at
    // 63.9375) at its end, a trench 4 wide and 9 deep across it from x 1 to 4, under the walls too (the dirt path's face
    // the only one to place the bridge's first block against)
    for (let x = -4; x <= 7; x++) for (let y = 64; y <= 69; y++) for (const z of [-1, 1]) bot.world.setBlock(new Vec3(x, y, z), 'stone')
    for (let y = 64; y <= 69; y++) bot.world.setBlock(new Vec3(-4, y, 0), 'stone')
    bot.world.setBlock(new Vec3(0, 63, 0), 'dirt_path')
    for (let x = 1; x <= 4; x++) for (let z = -1; z <= 1; z++) for (let y = 55; y <= 63; y++) bot.world.setBlock(new Vec3(x, y, z), 'air')
    await bot.waitForTicks(4)
    try {
      bot.entity.position = new Vec3(0.5, 63.9375, 0.5)
      bot.entity.velocity = new Vec3(0, 0, 0)
      const goal = new goals.GoalBlock(5, 64, 0)
      let final: any
      for await (const res of bot.pathfinder.getPathTo(goal)) final = res
      const path = final.result.path
      assert.equal(final.result.status, 'success', describe(path))
      // (a move from the dirt path that places a block under its feet' level: a bridge's; a tower from it goes up first)
      const fromPath = path.filter((m: any) => m.toPlace.some((p: any) => p.y < Math.floor(m.entryPos.y)) && bot.blockAt(m.entryPos.floored().offset(0, -1, 0))?.name === 'dirt_path')
      assert.deepEqual(fromPath.map((m: any) => m.moveType.constructor.name), [], describe(path))

      const failed: string[] = []
      bot.on('pathfinderMoveFailed', (info: any) => failed.push(String(info.error)))
      await withTimeout(bot.pathfinder.goto(goal), 40000, `goto timed out at ${bot.entity.position} (${failed.join(' | ')})`)
      const at = bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at} (${failed.join(' | ')})`)
      assert.deepEqual(failed, [])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
