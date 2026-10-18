import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { BreakHandler, PlaceHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

function forwardMove (toPlace: PlaceHandler[], toBreak: BreakHandler[]): any {
  return { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 64, 0.5), toPlace, toBreak }
}

test('a place or a dig whose block the world has as the move needs it already doesn\'t hold the move: the bot at its exit completes it', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // the floor the move would bridge is there (stone at y 63: an earlier try of the move placed it), and the block it
    // would dig is air (a leaf that decayed)
    const move = forwardMove([PlaceHandler.fromVec(new Vec3(1, 63, 0), 'solid')], [BreakHandler.fromVec(new Vec3(1, 64, 0), 'solid')])
    rig.bot.entity.position = new Vec3(1.5, 64, 0.5)
    rig.bot.entity.velocity = new Vec3(0, 0, 0)
    rig.bot.entity.onGround = true
    const executor = new NewForwardExecutor(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.defaultMoveSettings)
    executor.loadMove(move)
    assert.equal(executor.toPlaceLen(), 0)
    assert.equal(executor.toBreakLen(), 0)
    // the move's tick: complete, so it ends (it stood at the exit with no key held, never complete, until the
    // no-progress check failed it)
    assert.equal(await executor._performPerTick(move, 1, 0, [move]), true)

    // with the floor gone and the block back, both are to do again
    world.setBlock(new Vec3(1, 63, 0), 'air')
    world.setBlock(new Vec3(1, 64, 0), 'stone')
    const again = forwardMove([PlaceHandler.fromVec(new Vec3(1, 63, 0), 'solid')], [BreakHandler.fromVec(new Vec3(1, 64, 0), 'solid')])
    executor.loadMove(again)
    assert.equal(executor.toPlaceLen(), 1)
    assert.equal(executor.toBreakLen(), 1)
  } finally {
    rig.stopPassivePhysics()
  }
})
