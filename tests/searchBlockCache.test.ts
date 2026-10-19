import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Move } from '../src/mineflayer-specific/move'
import { MovementHandler } from '../src/mineflayer-specific/movements/movementProvider'
import { Forward } from '../src/mineflayer-specific/movements/movementProviders'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

const key = (v: Vec3): string => `${v.x},${v.y},${v.z}`

test('a block one branch of the search breaks is still there for another branch: the search\'s block cache keeps no break of a node it left', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    // stone all round the bot's cell: each way out is dug, feet and head
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (const y of [64, 65]) if (x !== 0 || z !== 0) world.setBlock(new Vec3(x, y, z), 'stone')
    const pf = rig.bot.pathfinder as any
    const forward = new Forward(rig.bot as any, pf.world, pf.defaultMoveSettings)
    const handler = new MovementHandler(rig.bot as any, pf.world, [forward])
    handler.loadGoal(new goals.GoalBlock(5, 64, 0))
    const start = Move.startMove(forward, new Vec3(0.5, 64, 0.5), new Vec3(0, 0, 0), 0)
    // one branch's node, in the bot's cell, got there through a move that broke the head block to the east
    const head = new Vec3(1, 65, 0)
    const viaBreak = Move.fromPrevious(1, new Vec3(0.5, 64, 0.5), start, forward, [], [BreakHandler.fromVec(head, 'solid')])
    const east = (moves: Move[]): Move | undefined => moves.find(m => Math.floor(m.exitPos.x) === 1 && Math.floor(m.exitPos.z) === 0)
    const there = east(handler.getNeighbors(viaBreak, new Set()))
    assert.deepEqual(there?.toBreak.map(b => key(b.vec)), ['1,64,0'], 'on its own branch the head block is broken already')
    // the start's own way east (another branch, which broke nothing) digs the head block too, as the world has it
    // stone: the cache kept the first branch's air, and a Forward on a play run broke only the feet block of a
    // staircase's step and pressed into the stone at its head (6 times on 26.3 seed 7)
    const fromStart = east(handler.getNeighbors(start, new Set()))
    assert.deepEqual(fromStart?.toBreak.map(b => key(b.vec)).sort(), ['1,64,0', '1,65,0'])
  } finally {
    rig.stopPassivePhysics()
  }
})
