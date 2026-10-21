import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Optimizer } from '../src/mineflayer-specific/post'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/**
 * A ledge's cell at (0, 64, 0) over a step down a block (the low ground at y 63 east and north of it: (1, 63, 0),
 * (1, 63, -1), (0, 63, -1) and (0, 63, -2)), and a leaf at head height over the drop straight ahead, (0, 65, -1): a
 * spruce's lowest leaves over the edge (f6-1.21.11, the bot at (-121, 68, -83) and the leaf at (-121, 69, -84)). With
 * no digging, the way down goes round the leaf: off the ledge east, north, then back west.
 */
function ledgeWorld (version: string, leaves = true) {
  const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  const world = (rig.bot as any).world
  for (const [x, z] of [[1, 0], [1, -1], [0, -1], [0, -2], [1, -2], [-1, -1], [-1, -2]]) {
    world.setBlock(new Vec3(x, 63, z), 'air')
    world.setBlock(new Vec3(x, 62, z), 'stone')
  }
  if (leaves) {
    world.setBlock(new Vec3(0, 65, -1), 'spruce_leaves')
    world.setBlock(new Vec3(-1, 65, -1), 'spruce_leaves')
  }
  rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
  return rig
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a drop merged with the moves after it doesn't walk into a leaf at head height the moves went round`, async () => {
    const rig = ledgeWorld(version)
    const failed: string[] = []
    const onFail = (info: any): void => { failed.push(`${String(info?.move?.type)} to ${String(info?.move?.to)}: ${String(info?.error)}`) }
    try {
      await new Promise(resolve => setTimeout(resolve, 200))
      ;(rig.bot as any).on('pathfinderMoveFailed', onFail)
      const goal = new goals.GoalBlock(0, 63, -2)
      await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `timed out at ${rig.bot.entity.position}`)
      const at = rig.bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
      assert.deepEqual(failed, [], 'a move failed')
    } finally {
      ;(rig.bot as any).off('pathfinderMoveFailed', onFail)
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: a drop is merged with the moves after it over the line the moves went round only when the line is clear`, async () => {
    for (const leaves of [true, false]) {
      const rig = ledgeWorld(version, leaves)
      try {
        let result: any
        for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(0, 63, -2))) result = res.result
        assert.equal(result.status, 'success')
        const optimizer = new Optimizer(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.getActiveMappings().optimizers)
        optimizer.loadPath(result.path)
        const runs = await optimizer.compute()
        const drop = runs.find((m: any) => m.moveType.constructor.name === 'ForwardDropDown')
        assert.ok(drop != null, 'the path drops off the ledge')
        // under the leaf the drop goes east, its own exit; with none it goes straight on to the goal
        if (leaves) assert.deepEqual(drop.exitPos.toArray(), [1.5, 63, 0.5], `the drop was merged on to ${String(drop.exitPos)}`)
        else assert.deepEqual(drop.exitPos.toArray(), [0.5, 63, -1.5], `the drop was merged on to ${String(drop.exitPos)}`)
      } finally {
        rig.stopPassivePhysics()
      }
    }
  })
}
