import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { supportedCell } from '../src/mineflayer-specific/post/optimizers'
import { createCacheWorld } from './setup'

// DropDownOpt merges a drop with the moves after it into one straight walk from the drop's start to the last one's
// exit. The A* went round a cell its step exclusions keep out of (the nether's rules forbid standing on magma); the
// straight line cut across it, the bot on it before it dropped. A 26.3 bot by seed 2's fortress, stepped off a magma
// block on a bridge's wall by the hazard reflex, was walked back onto it by the next path's merged drop, 430 times,
// till it died.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/**
 * The fake rig's floor cut away round a lane one block wide two blocks down (stand at y 62, along z from 1 to -14 at
 * x 0), a ledge's cell at (1, 64, 1) to start from, and a magma block beside it at (1, 63, 0): seed 2's bridge, the
 * delta's step down onto its wall and the magma on the wall
 */
function bridgeWorld () {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(1.5, 64, 1.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  const world = (rig.bot as any).world
  for (let x = -3; x <= 4; x++) for (let z = -16; z <= 4; z++) world.setBlock(new Vec3(x, 63, z), 'air')
  for (let z = -14; z <= 1; z++) world.setBlock(new Vec3(0, 61, z), 'stone')
  world.setBlock(new Vec3(1, 63, 1), 'stone')
  world.setBlock(new Vec3(1, 63, 0), 'magma_block')
  // the nether's rule: no standing on magma (MagmaBlock.stepOn hurts a player who isn't sneaking)
  const noMagma = (block: { position: Vec3 }): number => rig.bot.blockAt(block.position.offset(0, -1, 0))?.name === 'magma_block' ? 1000000 : 0
  rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false, infiniteLiquidDropdownDistance: false, exclusionAreasStep: [noMagma as any] })
  return rig
}

test('a drop merged with the walk after it never stands on a cell the step exclusions forbid', async () => {
  const rig = bridgeWorld()
  const onMagma: string[] = []
  const onTick = (): void => {
    const pos = rig.bot.entity.position
    if (rig.bot.entity.onGround && rig.bot.blockAt(pos.offset(0, -0.2, 0).floored())?.name === 'magma_block') onMagma.push(pos.toString())
  }
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    rig.bot.on('physicsTick', onTick)
    const goal = new goals.GoalBlock(0, 62, -14)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, `timed out at ${rig.bot.entity.position}`)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
    assert.deepEqual(onMagma, [], 'stood on the magma')
  } finally {
    rig.bot.off('physicsTick', onTick)
    rig.stopPassivePhysics()
  }
})

test('the cell a player stands in is over the block nearest its middle that holds it up', () => {
  const rig = bridgeWorld()
  try {
    const world = rig.bot.pathfinder.world as any
    // over the stone's middle; over the magma's; the box over both, the middle over the stone
    assert.deepEqual(supportedCell(world, new Vec3(1.5, 64, 1.5))?.toArray(), [1, 64, 1])
    assert.deepEqual(supportedCell(world, new Vec3(1.5, 64, 0.5))?.toArray(), [1, 64, 0])
    assert.deepEqual(supportedCell(world, new Vec3(1.5, 64, 1.1))?.toArray(), [1, 64, 1])
    assert.deepEqual(supportedCell(world, new Vec3(1.5, 64, 0.9))?.toArray(), [1, 64, 0])
    // the middle over air past the ledge's edge, the box still on the stone
    assert.deepEqual(supportedCell(world, new Vec3(2.2, 64, 1.5))?.toArray(), [1, 64, 1])
    assert.equal(supportedCell(world, new Vec3(3.5, 64, 1.5)), null)
  } finally {
    rig.stopPassivePhysics()
  }
})
