import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A move that ends in a cell with a deadly fall beside it (Movement.deadlyFall: lava or fire, or no ground within a
// safe drop) costs edgeHazardCost more for each such side (Movement.edgeHazard): a knockback, a slide or a step off the
// line comes down there. A 26.3 nether bot cut across the corners of two of a basalt delta's lava shafts on a
// Diagonal, drifted 0.3 off the line, fell into one and burned; others walked ledges over the lava sea and a blaze's
// fireball knocked them off.

async function planTo (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

/**
 * The fake rig's one-block floor at y 63 cut away (the void under it) but for a ridge one block wide along x from the
 * start to x = 10, and a wide way round (z 6 to 9) joined to it at both ends; lava at the void's top under the ridge's
 * sides when `lava`
 */
function ridgeWorld (lava: boolean) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  const world = (rig.bot as any).world
  for (let x = -2; x <= 12; x++) {
    for (let z = -6; z <= 12; z++) {
      const ridge = z === 0
      const way = (z >= 6 && z <= 9) || ((x <= 0 || x >= 10) && z >= 0)
      if (!ridge && !way) {
        world.setBlock(new Vec3(x, 63, z), 'air')
        if (lava) world.setBlock(new Vec3(x, 58, z), 'lava')
      }
    }
  }
  return rig
}

test('a path takes a wide way round rather than a ridge with a deadly fall either side', async () => {
  for (const lava of [false, true]) {
    const rig = ridgeWorld(lava)
    try {
      const pf = rig.bot.pathfinder as any
      assert.ok(pf.defaultMoveSettings.edgeHazardCost > 0, 'edgeHazardCost is on by default')
      // the pathfinder's other ways over (bridging, digging down) are left out: the walk alone is compared
      rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
      const result = await planTo(rig.bot, new goals.GoalBlock(10, 64, 0))
      assert.equal(result.status, 'success')
      const onRidge = result.path.filter((m: any) => Math.floor(m.exitPos.z) === 0 && m.exitPos.x > 1 && m.exitPos.x < 9)
      assert.equal(onRidge.length, 0, `the path walks the ridge${lava ? ' over the lava' : ''}: ${result.path.map((m: any) => m.exitPos.floored().toString()).join(' ')}`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})

test('with edgeHazardCost 0 the path walks the ridge, the shortest way', async () => {
  const rig = ridgeWorld(true)
  try {
    rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false, edgeHazardCost: 0 })
    const result = await planTo(rig.bot, new goals.GoalBlock(10, 64, 0))
    assert.equal(result.status, 'success')
    assert.ok(result.path.every((m: any) => Math.floor(m.exitPos.z) === 0), result.path.map((m: any) => m.exitPos.floored().toString()).join(' '))
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a cell\'s deadly sides are counted: ground beside, a drop of maxDropDown onto stone or into water are none; lava under a drop, or the void, are', async () => {
  const { Forward } = await import('../src/mineflayer-specific/movements/movementProviders')
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  try {
    const pf = rig.bot.pathfinder as any
    const move = new Forward(rig.bot, pf.world, pf.defaultMoveSettings)
    const cost = pf.defaultMoveSettings.edgeHazardCost
    const cell = (): any => pf.world.getBlockInfo(new Vec3(0, 64, 0))
    const fresh = (): void => pf.world.clearCache()
    assert.equal(move.edgeHazard(cell()), 0, 'flat ground')
    // the column east of the cell: a hole down to the void
    world.setBlock(new Vec3(1, 63, 0), 'air'); fresh()
    assert.equal(move.edgeHazard(cell()), cost, 'the void east')
    world.setBlock(new Vec3(1, 60, 0), 'stone'); fresh()
    assert.equal(move.edgeHazard(cell()), 0, 'a drop of 3 onto stone (maxDropDown 3)')
    world.setBlock(new Vec3(1, 60, 0), 'lava'); fresh()
    assert.equal(move.edgeHazard(cell()), cost, 'lava under the drop')
    world.setBlock(new Vec3(1, 60, 0), 'water'); fresh()
    assert.equal(move.edgeHazard(cell()), 0, 'water under the drop')
    // and west and north too
    world.setBlock(new Vec3(-1, 63, 0), 'air'); world.setBlock(new Vec3(0, 63, -1), 'air'); fresh()
    assert.equal(move.edgeHazard(cell()), 2 * cost, 'the void west and north')
    // a wall at the feet beside is no fall
    world.setBlock(new Vec3(-1, 64, 0), 'stone'); fresh()
    assert.equal(move.edgeHazard(cell()), cost, 'a wall west')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a diagonal across the corners of two lava shafts is not taken when a way round is near (a basalt delta)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  const world = (rig.bot as any).world
  try {
    rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
    // the shafts at (1, 0) and (0, 1), down to lava; the cells (0, 0) and (1, 1) touch at a corner only
    for (const [x, z] of [[1, 0], [0, 1]]) {
      world.setBlock(new Vec3(x, 63, z), 'air')
      world.setBlock(new Vec3(x, 60, z), 'lava')
    }
    const result = await planTo(rig.bot, new goals.GoalBlock(1, 64, 1))
    assert.equal(result.status, 'success')
    assert.ok(!(result.path.length === 1 && result.path[0].moveType.constructor.name === 'Diagonal'), 'the path cut across the shafts\' corners')
    // with no edge cost it is the one move there
    rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false, edgeHazardCost: 0 })
    const straight = await planTo(rig.bot, new goals.GoalBlock(1, 64, 1))
    assert.deepEqual(straight.path.map((m: any) => m.moveType.constructor.name), ['Diagonal'])
  } finally {
    rig.stopPassivePhysics()
  }
})

/** the optimizer's runs of a path (Forward and Diagonal runs merged into straight lines: LandStraightAheadOpt) */
async function optimized (rig: any, path: any[]): Promise<any[]> {
  const { Optimizer } = await import('../src/mineflayer-specific/post')
  const optimizer = new Optimizer(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.getActiveMappings().optimizers)
  optimizer.loadPath(path)
  return await optimizer.compute()
}

/** the cells at the feet's level the straight lines of the runs cross, sampled every 0.1 of a block */
function runCells (runs: any[]): Vec3[] {
  const out: Vec3[] = []
  for (const run of runs) {
    const a = run.entryPos.floored().offset(0.5, 0, 0.5)
    const b = run.exitPos
    const n = Math.max(1, Math.ceil(a.distanceTo(b) * 10))
    for (let i = 0; i <= n; i++) out.push(a.plus(b.minus(a).scaled(i / n)).floored())
  }
  return out
}

test('the straight lines the optimizer merges a path into keep off the cells it went round: a soft exclusion zone, a ledge\'s edge', async () => {
  // a soft zone (40 a cell) on the straight way from (0, 64, 0) to (16, 64, 0), round x 8, a way round it either side
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  try {
    const inZone = (p: { x: number, z: number }): boolean => Math.abs(p.x - 8) <= 2 && Math.abs(p.z) <= 2
    const zone = (block: any): number => inZone(block.position) ? 40 : 0
    rig.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false, exclusionAreasStep: [zone as any] })
    const result = await planTo(rig.bot, new goals.GoalBlock(16, 64, 0))
    assert.equal(result.status, 'success')
    assert.ok(result.path.every((m: any) => !inZone(m.exitPos.floored())), 'the search went through the zone')
    const runs = await optimized(rig, result.path)
    const crossed = runCells(runs).filter(inZone)
    assert.equal(crossed.length, 0, `a run's straight line crosses the zone at ${crossed[0]?.toString()}: ${runs.map((r: any) => `${r.entryPos.floored()} > ${r.exitPos.floored()}`).join(', ')}`)
  } finally {
    rig.stopPassivePhysics()
  }

  // a ledge three wide (z -1 to 1) over the void from x -4 to 20: from (0, 64, 1) to (16, 64, 1), along its south edge,
  // the path goes along its middle (z 0, no void beside it), and the lines it's merged into keep to it
  const ledge = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 1.5)).rig
  ledge.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, partialPathLength: 50 } }))
  const world = (ledge.bot as any).world
  try {
    for (let x = -6; x <= 22; x++) for (let z = -8; z <= 8; z++) if (Math.abs(z) > 1 || x < -4 || x > 20) world.setBlock(new Vec3(x, 63, z), 'air')
    ledge.bot.pathfinder.setMoveOptions({ canPlace: false, canDig: false })
    const result = await planTo(ledge.bot, new goals.GoalBlock(16, 64, 1))
    assert.equal(result.status, 'success')
    const along = result.path.slice(1, -1)
    assert.ok(along.every((m: any) => Math.floor(m.exitPos.z) === 0), `the path keeps to the edge: ${result.path.map((m: any) => m.exitPos.floored().toString()).join(' ')}`)
    const runs = await optimized(ledge, result.path)
    const edge = runCells(runs).filter(c => c.z === 1 && c.x > 1 && c.x < 15)
    assert.equal(edge.length, 0, `a run's straight line goes along the edge at ${edge[0]?.toString()}: ${runs.map((r: any) => `${r.entryPos.floored()} > ${r.exitPos.floored()}`).join(', ')}`)
  } finally {
    ledge.stopPassivePhysics()
  }
})
