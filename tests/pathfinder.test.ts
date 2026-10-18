import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// require('debug').disable()

type PathResult = {
  status: string
  path: Array<{ x: number, y: number, z: number, moveType?: { constructor?: { name?: string } } }>
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => {
      if (timer != null) clearTimeout(timer)
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ])
}

function preparePathRig(options: {
  inventoryItems?: (mcData: any) => Array<{ type: number, count: number, name: string }>
  moveSettings?: Record<string, unknown>
} = {}) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig

  if (options.inventoryItems != null) {
    rig.bot.inventory.items = () => options.inventoryItems!(rig.mcData) as any
  }

  rig.bot.loadPlugin(createPlugin({
    pathfinderSettings: { partialPathProducer: true, partialPathLength: 50 },
    moveSettings: options.moveSettings as any
  }))

  return rig
}

async function collectPathResult(
  bot: ReturnType<typeof preparePathRig>['bot'],
  goal: goals.Goal,
  timeoutMs = 15000
): Promise<PathResult> {
  let final: { result: PathResult } | undefined

  await withTimeout((async () => {
    for await (const res of bot.pathfinder.getPathTo(goal)) {
      final = res as { result: PathResult }
    }
  })(), timeoutMs, `timed out while planning to ${goal.constructor.name}`)

  if (final == null) {
    throw new Error('path planner finished without a final result')
  }

  return final.result
}

test('getPathTo succeeds on an unobstructed flat path', async () => {
  const rig = preparePathRig()

  try {
    const result = await collectPathResult(rig.bot, new goals.GoalBlock(20, 64, 0))
    const last = result.path[result.path.length - 1]

    assert.equal(result.status, 'success')
    assert.equal(last?.x, 20)
    assert.equal(last?.y, 64)
    assert.equal(last?.z, 0)
    assert.equal(result.path.length, 21)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto resolves when the bot already stands at the goal (an empty path)', async () => {
  const rig = preparePathRig()

  try {
    // in the middle of its block
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const start = rig.bot.entity.position.floored()
    const result = await collectPathResult(rig.bot, new goals.GoalBlock(start.x, start.y, start.z))
    assert.equal(result.status, 'success')
    assert.equal(result.path.length, 0)

    await withTimeout(rig.bot.pathfinder.goto(new goals.GoalBlock(start.x, start.y, start.z)), 5000, 'goto to the block the bot stands in timed out')
    await withTimeout(rig.bot.pathfinder.goto(new goals.GoalNear(start.x, start.y, start.z, 1)), 5000, 'goto near the bot timed out')
    assert.deepEqual(rig.bot.entity.position.floored().toArray(), start.toArray())
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto ends with the bot where the goal holds, not short of its last block', async () => {
  for (const [x, z] of [[3, -2], [4, 3], [-3, -3], [5, 0]]) {
    const rig = preparePathRig()
    try {
      rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
      const goal = new goals.GoalBlock(x, 64, z)
      await withTimeout(rig.bot.pathfinder.goto(goal), 15000, `goto to ${x}, ${z} timed out`)
      const at = rig.bot.entity.position
      assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `goto to ${x}, 64, ${z} ended at ${at}`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})

test('getPathTo succeeds when it needs a one-block tower and the bot has a block to place', async () => {
  const rig = preparePathRig({
    inventoryItems: (mcData) => [{ type: mcData.itemsByName.dirt.id, count: 2, name: 'dirt' }]
  })

  try {
    const result = await collectPathResult(rig.bot, new goals.GoalBlock(0, 66, 0))
    const last = result.path[result.path.length - 1]

    assert.equal(result.status, 'success')
    assert.equal(last?.x, 0)
    assert.equal(last?.y, 66)
    assert.equal(last?.z, 0)
    assert(result.path.some((move) => move.moveType?.constructor?.name === 'StraightUp'), 'expected the plan to use a vertical tower move')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('getPathTo fails when a one-block tower is required but the bot has no blocks to place', async () => {
  const rig = preparePathRig()

  try {
    await assert.rejects(
      collectPathResult(rig.bot, new goals.GoalBlock(0, 65, 0), 4000),
      /timed out while planning to GoalBlock/
    )
  } finally {
    rig.stopPassivePhysics()
  }
})

test('getPathTo fails when a one-block tower is required but placement is disabled', async () => {
  const rig = preparePathRig({
    inventoryItems: (mcData) => [{ type: mcData.itemsByName.dirt.id, count: 1, name: 'dirt' }],
    moveSettings: { canPlace: false }
  })

  try {
    await assert.rejects(
      collectPathResult(rig.bot, new goals.GoalBlock(0, 65, 0), 4000),
      /timed out while planning to GoalBlock/
    )
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a parkour jump that lands off its block gives the move up instead of steering on (no walk away from the goal)', async () => {
  // the End's ground beside a spike (seed endfight, shifted by 40, 0, 3): a one-block step down along x and a notch,
  // where the plan jumps diagonally from the step's corner over the notch (ParkourDiagonal to 2, 64, 2), aiming at the
  // landing block's near corner, and the drop carries the bot past it
  const rig = preparePathRig()
  const world = (rig.bot as any).world
  try {
    for (let x = 3; x <= 12; x++) {
      for (let z = -6; z <= 8; z++) {
        if ((x === 3 && z >= 4) || (x === 4 && z >= 6)) continue
        world.setBlock(new Vec3(x, 64, z), 'stone')
      }
    }
    rig.bot.entity.position = new Vec3(7.5, 65, -0.5)
    const goal = new goals.GoalBlock(2, 64, 2)
    const result = await collectPathResult(rig.bot, goal)
    assert.equal(result.path[result.path.length - 1]?.moveType?.constructor?.name, 'ParkourDiagonal')
    // it settles (at the goal, or with an error for the caller to plan again) instead of walking on with the locked yaw
    await withTimeout(rig.bot.pathfinder.goto(goal).catch(() => {}), 20000, 'goto down the step never settled')
    const at = rig.bot.entity.position
    assert.ok(Math.hypot(at.x - 2.5, at.z - 2.5) < 4, `goto left the bot at ${at}, away from the goal`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a path starts where the bot stands: the start is snapped into the supporting block, not to its corner', async () => {
  const { getSupportedStartPos } = await import('../src/utils')
  const rig = preparePathRig()
  try {
    const world = (rig.bot as any).world
    const pfWorld = rig.bot.pathfinder.world
    // over its own block: its own point (it used to be (0, 64, 0), which a bot in a 1x1 shaft walks to for ever)
    assert.deepEqual(getSupportedStartPos(pfWorld, new Vec3(0.5, 64, 0.5)).toArray(), [0.5, 64, 0.5])
    assert.deepEqual(getSupportedStartPos(pfWorld, new Vec3(0.9, 64, 0.2)).toArray(), [0.9, 64, 0.2])
    // over the edge of a hole, held up by the block beside it: the nearest point over that block
    world.setBlock(new Vec3(1, 63, 0), 'air')
    const edge = getSupportedStartPos(pfWorld, new Vec3(1.2, 64, 0.5))
    assert.ok(Math.floor(edge.x) === 0 && edge.x > 0.99 && edge.z === 0.5, edge.toString())

    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const result: any = await collectPathResult(rig.bot, new goals.GoalBlock(5, 64, 3))
    assert.equal(result.status, 'success')
    assert.deepEqual(result.path[0].entryPos.toArray(), [0.5, 64, 0.5])
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a tunnel through a wall goes straight on: Forward breaks the feet block as well as the head block', async () => {
  const rig = preparePathRig()
  const world = (rig.bot as any).world
  try {
    // a stone ridge 4 thick and 6 high across the way, nothing to go round it by within reach
    for (let x = 3; x <= 6; x++) for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(x, y, z), 'stone')
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    // a goal in the ridge's first column: a tunnel in from this side is the way (round the far side digs as much)
    const result = await collectPathResult(rig.bot, new goals.GoalBlock(3, 64, 0))
    assert.equal(result.status, 'success')
    const kinds = result.path.map(m => m.moveType?.constructor?.name)
    // it used to climb into the wall and drop again at every block (ForwardJump, StraightDown, ...)
    assert.deepEqual(kinds, new Array(3).fill('Forward'))
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a dig by hand that takes longer than 5 s of wall clock (stone, 150 ticks) is waited out, not timed out', async () => {
  const rig = preparePathRig()
  const world = (rig.bot as any).world
  try {
    for (let x = 3; x <= 6; x++) for (let y = 64; y < 70; y++) for (let z = -30; z <= 30; z++) world.setBlock(new Vec3(x, y, z), 'stone')
    world.setBlock(new Vec3(3, 64, 0), 'dirt')
    rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = new goals.GoalBlock(3, 64, 0)
    await withTimeout(rig.bot.pathfinder.goto(goal), 40000, 'goto into the wall timed out')
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a diagonal parkour jump is planned only when the box\'s way across is clear: not past a block at the corner beside the line', async () => {
  for (const blocked of [false, true]) {
    const rig = preparePathRig({ moveSettings: { canDig: false, canPlace: false } })
    const world = (rig.bot as any).world
    try {
      // two one-block pillars in a pit too deep to drop into: the start (0, 0) and the landing (2, 2)
      for (let x = -4; x <= 6; x++) for (let z = -4; z <= 6; z++) for (let y = 40; y < 64; y++) world.setBlock(new Vec3(x, y, z), 'air')
      world.setBlock(new Vec3(0, 63, 0), 'stone')
      world.setBlock(new Vec3(2, 63, 2), 'stone')
      // a block standing beside the line from one to the other, at the corner (2, 1) of the jump
      if (blocked) for (let y = 62; y <= 65; y++) world.setBlock(new Vec3(2, y, 1), 'stone')
      rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
      let final: any
      await withTimeout((async () => { for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(2, 64, 2))) final = res })(), 15000, 'planning timed out')
      const jumps = final.result.path.filter((m: any) => m.moveType.constructor.name === 'ParkourDiagonal' && m.x === 2 && m.z === 2)
      if (blocked) assert.equal(jumps.length, 0, 'planned the jump past the block')
      else assert.equal(jumps.length, 1, `no jump: ${final.result.status}`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})
