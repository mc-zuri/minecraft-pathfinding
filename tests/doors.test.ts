import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld, loadMcData } from './setup'

const VERSION = '1.20.4'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

async function finalPath (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  await withTimeout((async () => { for await (const res of bot.pathfinder.getPathTo(goal)) final = res })(), 15000, 'planning timed out')
  return final.result
}

/** the state id of a block with these properties (the rest as the block's default state) */
function stateOf (name: string, props: Record<string, unknown>): number {
  const { Block, mcData } = loadMcData(VERSION)
  const defaults = Block.fromStateId(mcData.blocksByName[name].defaultState as number, 0).getProperties()
  return (Block as any).fromProperties(name, { ...defaults, ...props }, 0).stateId
}

/**
 * A wall along x = 3 (z -20 to 20, 3 high) with one opening at z = 0, which `fill` fills: the bot at (0.5, 64, 0.5),
 * the goal past the wall at (6, 64, 0)
 */
function walled (fill: (world: any) => void, wall = 'stone'): ReturnType<typeof createCacheWorld>['rig'] {
  const rig = createCacheWorld(VERSION, 64, new Vec3(0, 64, 0)).rig
  const world = (rig.bot as any).world
  for (let y = 64; y < 67; y++) for (let z = -20; z <= 20; z++) if (z !== 0 || y === 66) world.setBlock(new Vec3(3, y, z), wall)
  fill(world)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  return rig
}

test('an open fence gate is walked through, not dug (its open state has no collision shape: FenceGateBlock)', async () => {
  const rig = walled((world) => {
    world.setBlock(new Vec3(3, 64, 0), stateOf('oak_fence_gate', { facing: 'east', open: true }))
    world.setBlock(new Vec3(3, 65, 0), 'air')
  }, 'oak_fence')
  rig.bot.loadPlugin(createPlugin())
  try {
    const info = rig.bot.pathfinder.world.getBlockInfo(new Vec3(3, 64, 0))
    assert.equal(info.physical, false)
    assert.equal(info.walkthrough, true)
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    assert.deepEqual(result.path.flatMap((m: any) => m.toBreak.map((b: any) => b.vec.toString())), [], 'nothing is dug')
    assert.ok(result.path.some((m: any) => m.x === 3 && m.z === 0), 'the path goes through the gate')
  } finally {
    rig.stopPassivePhysics()
  }
})

const breaks = (result: any): string[] => result.path.flatMap((m: any) => m.toBreak.filter((b: any) => b.constructor.name === 'BreakHandler').map((b: any) => b.vec.toString()))
const opens = (result: any): string[] => result.path.flatMap((m: any) => m.toBreak.filter((b: any) => b.constructor.name === 'OpenHandler').map((b: any) => b.vec.toString()))
const through = (result: any): boolean => result.path.some((m: any) => m.x === 3 && m.z === 0)

/** a door in the wall's opening: its halves at (3, 64, 0) and (3, 65, 0) */
function door (world: any, name: string, props: Record<string, unknown>): void {
  world.setBlock(new Vec3(3, 64, 0), stateOf(name, { ...props, half: 'lower' }))
  world.setBlock(new Vec3(3, 65, 0), stateOf(name, { ...props, half: 'upper' }))
}

// a closed door facing east has its panel across the cell's west edge, where the bot comes in; open, along its north
// edge (DoorBlock.getShape)
const CLOSED_EAST = { facing: 'east', hinge: 'left', open: false }

test('a path goes through a closed wooden door, opening it at a small cost (no dig)', async () => {
  const rig = walled((world) => door(world, 'oak_door', CLOSED_EAST))
  rig.bot.loadPlugin(createPlugin())
  try {
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    assert.ok(through(result), 'the path goes through the doorway')
    assert.deepEqual(breaks(result), [], 'nothing is dug')
    assert.ok(opens(result).length > 0, 'the door is opened')
    // the walk and the open: well under a dig of the wall (stone by hand is 150 ticks)
    assert.ok(result.cost < 60, `cost ${result.cost}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto walks through a closed wooden door: it right-clicks it, the server opens it, it walks through', async () => {
  const rig = walled((world) => door(world, 'spruce_door', CLOSED_EAST))
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false } as any }))
  const world = (rig.bot as any).world
  try {
    const goal = new goals.GoalBlock(6, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, 'goto timed out')
    assert.ok(goal.isEnd(rig.bot.entity.position.floored() as any), `ended at ${rig.bot.entity.position}`)
    assert.ok((rig.bot as any).activatedBlocks.length > 0, 'the door was right-clicked')
    assert.equal(world.getBlock(new Vec3(3, 64, 0)).name, 'spruce_door', 'the door is still there')
    assert.equal(world.getBlock(new Vec3(3, 64, 0)).getProperties().open, true)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto walks through a closed fence gate in a fence (the gate is 1.5 high, as the fence: neither is jumped)', async () => {
  const rig = walled((world) => {
    world.setBlock(new Vec3(3, 64, 0), stateOf('birch_fence_gate', { facing: 'east', open: false }))
    world.setBlock(new Vec3(3, 65, 0), 'air')
  }, 'oak_fence')
  const world = (rig.bot as any).world
  for (let z = -20; z <= 20; z++) for (let y = 65; y < 67; y++) world.setBlock(new Vec3(3, y, z), 'air')
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false } as any }))
  try {
    const goal = new goals.GoalBlock(6, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 30000, 'goto timed out')
    assert.ok(goal.isEnd(rig.bot.entity.position.floored() as any), `ended at ${rig.bot.entity.position}`)
    assert.equal(world.getBlock(new Vec3(3, 64, 0)).name, 'birch_fence_gate')
    assert.equal(world.getBlock(new Vec3(3, 64, 0)).getProperties().open, true)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a fence and a closed gate are not jumped: with no opening, digging or placing the path goes round the end of the fence', async () => {
  const rig = walled((world) => {
    world.setBlock(new Vec3(3, 64, 0), stateOf('oak_fence_gate', { facing: 'east', open: false }))
    world.setBlock(new Vec3(3, 65, 0), 'air')
  }, 'oak_fence')
  const world = (rig.bot as any).world
  for (let z = -20; z <= 20; z++) for (let y = 65; y < 67; y++) world.setBlock(new Vec3(3, y, z), 'air')
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false, canPlace: false, canOpenDoors: false } as any }))
  try {
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    const over = result.path.filter((m: any) => m.x === 3 && Math.abs(m.z) <= 20)
    assert.deepEqual(over.map((m: any) => [m.x, m.y, m.z]), [], 'nothing over the fence or the gate')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('an iron door is a wall: not opened, not dug, the path goes round (or through the stone) instead', async () => {
  const rig = walled((world) => door(world, 'iron_door', CLOSED_EAST))
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    assert.ok(!through(result), 'not through the iron door')
    assert.deepEqual(opens(result), [])
    assert.ok(!breaks(result).some((b) => b === new Vec3(3, 64, 0).toString() || b === new Vec3(3, 65, 0).toString()), 'the door is not dug')
    assert.equal(world.getBlock(new Vec3(3, 64, 0)).name, 'iron_door')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('an open door is gone through along its panel, and not out of its cell across it', async () => {
  // open, facing east, hinge left: the panel along the cell's north edge; the bot comes in from the west
  const rig = walled((world) => door(world, 'oak_door', { ...CLOSED_EAST, open: true }))
  rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false } as any }))
  try {
    const result = await finalPath(rig.bot, new goals.GoalBlock(6, 64, 0))
    assert.equal(result.status, 'success')
    assert.ok(through(result))
    assert.deepEqual(opens(result), [], 'an open door is not clicked')
    assert.deepEqual(breaks(result), [])
  } finally {
    rig.stopPassivePhysics()
  }
})

for (const [name, how] of [['iron_door', 'by a face its panel leaves clear'], ['oak_door', 'by a face its panel leaves clear, or shuts it first']]) {
  test(`out of an open ${name}'s cell the path goes ${how}, not through the panel`, async () => {
    // the bot in the doorway of an open door whose panel is along the cell's north edge, the goal to the north
    const rig = createCacheWorld(VERSION, 64, new Vec3(0, 64, 0)).rig
    const world = (rig.bot as any).world
    door(world, name, { ...CLOSED_EAST, open: true })
    rig.bot.entity.position = new Vec3(3.5, 64, 0.5)
    rig.bot.loadPlugin(createPlugin({ moveSettings: { canDig: false, canPlace: false } as any }))
    try {
      const result = await finalPath(rig.bot, new goals.GoalBlock(3, 64, -3))
      assert.equal(result.status, 'success')
      const first = result.path[0]
      // shut, its panel is along the west edge (the door facing east closed), clear of the way north
      const shuts = first.toBreak.some((b: any) => b.constructor.name === 'OpenHandler')
      if (name === 'iron_door') assert.ok(!shuts)
      assert.ok(first.z === 0 || shuts, `the first move ${first.x}, ${first.z} goes through the panel`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('the block cache follows a door\'s and a gate\'s toggles (the server\'s block updates of both halves)', async () => {
  const rig = createCacheWorld(VERSION, 64, new Vec3(0, 64, 0)).rig
  const world = (rig.bot as any).world
  door(world, 'oak_door', CLOSED_EAST)
  world.setBlock(new Vec3(5, 64, 0), stateOf('oak_fence_gate', { facing: 'east', open: false }))
  rig.bot.loadPlugin(createPlugin())
  try {
    const cache = rig.bot.pathfinder.world
    const lower = new Vec3(3, 64, 0)
    const upper = new Vec3(3, 65, 0)
    const gate = new Vec3(5, 64, 0)
    for (const pos of [lower, upper, gate]) assert.equal(cache.getBlockInfo(pos).block?.getProperties().open, false)
    // the right click's answer, as the server sends it (the fake server toggles on the next tick)
    await (rig.bot as any).activateBlock(world.getBlock(lower))
    await (rig.bot as any).activateBlock(world.getBlock(gate))
    await rig.bot.waitForTicks(2)
    for (const pos of [lower, upper, gate]) assert.equal(cache.getBlockInfo(pos).block?.getProperties().open, true, pos.toString())
    assert.equal(cache.getBlockInfo(gate).walkthrough, true)
  } finally {
    rig.stopPassivePhysics()
  }
})
