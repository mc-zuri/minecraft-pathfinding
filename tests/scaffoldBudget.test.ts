import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Move } from '../src/mineflayer-specific/move'
import { MovementHandler } from '../src/mineflayer-specific/movements/movementProvider'
import { Diagonal } from '../src/mineflayer-specific/movements/movementProviders'
import { createCacheWorld } from './setup'

// The blocks a search plans to place are a budget: the scaffolding the inventory holds when it starts, less a reserve
// (scaffoldReserve), each node's path taking its own out. A path over the nether's lava sea planned the bot's last
// block and one more (a diagonal's two with one left), and halfway over it the bot had none: 'no item to place', a
// fall, and the bot dead in the lava (3 times on 26.3 nether runs).

function rigWith (cobblestone: number, moveSettings: Record<string, unknown> = {}) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.inventory.items = () => cobblestone > 0 ? [{ type: rig.mcData.itemsByName.cobblestone.id, count: cobblestone, name: 'cobblestone' }] as any : []
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTimeoutMs: 1500 }, moveSettings: moveSettings as any }))
  return rig
}

/** a strip of lava `width` blocks wide east of the bot, `span` blocks either way, nothing under it */
function lavaStrip (rig: ReturnType<typeof rigWith>, width: number, span = 60): void {
  const world = (rig.bot as any).world
  for (let x = 2; x < 2 + width; x++) for (let z = -span; z <= span; z++) world.setBlock(new Vec3(x, 63, z), 'lava')
}

async function search (rig: ReturnType<typeof rigWith>, goal: goals.Goal): Promise<{ status: string, path: Move[] }> {
  let last: any
  for await (const res of rig.bot.pathfinder.getPathTo(goal)) last = res.result
  return last
}

const placed = (path: Move[]): number => path.reduce((n, m) => n + m.toPlace.length, 0)

test('a bridge over lava is planned with the blocks the bot holds less the reserve, not more', async () => {
  // five blocks of lava to bridge: ten blocks (a budget of six) make it, eight (four) don't
  const enough = rigWith(10)
  try {
    lavaStrip(enough, 5)
    const res = await search(enough, new goals.GoalBlock(8, 64, 0))
    assert.equal(res.status, 'success')
    assert.equal(placed(res.path), 5)
  } finally {
    enough.stopPassivePhysics()
  }

  const short = rigWith(8)
  try {
    lavaStrip(short, 5)
    const res = await search(short, new goals.GoalBlock(8, 64, 0))
    assert.notEqual(res.status, 'success', 'a bridge of 5 planned with 8 blocks and a reserve of 4')
    assert.ok(placed(res.path) <= 4, `the way to the best node places ${placed(res.path)} blocks of a budget of 4`)
    for (const m of res.path) assert.ok(m.remainingBlocks >= 0)
  } finally {
    short.stopPassivePhysics()
  }

  // the reserve is a setting: with none, the eight make it
  const noReserve = rigWith(8, { scaffoldReserve: 0 })
  try {
    lavaStrip(noReserve, 5)
    const res = await search(noReserve, new goals.GoalBlock(8, 64, 0))
    assert.equal(res.status, 'success')
  } finally {
    noReserve.stopPassivePhysics()
  }
})

test('a move that places two blocks is not planned with one left in the budget (a diagonal over a corner)', async () => {
  const rig = rigWith(0)
  const world = (rig.bot as any).world
  try {
    // no floor south, east or south-east of the bot: the diagonal places the south one and the south-east one
    for (const [x, z] of [[0, 1], [1, 0], [1, 1]]) world.setBlock(new Vec3(x, 63, z), 'air')
    const pf = rig.bot.pathfinder as any
    const diagonal = new Diagonal(rig.bot as any, pf.world, pf.defaultMoveSettings)
    const handler = new MovementHandler(rig.bot as any, pf.world, [diagonal])
    handler.loadGoal(new goals.GoalBlock(5, 64, 5))
    const southEast = (budget: number): Move | undefined => {
      const start = Move.startMove(diagonal, new Vec3(0.5, 64, 0.5), new Vec3(0, 0, 0), budget)
      return handler.getNeighbors(start, new Set()).find(m => Math.floor(m.exitPos.x) === 1 && Math.floor(m.exitPos.z) === 1)
    }
    assert.equal(southEast(2)?.toPlace.length, 2, 'with two blocks it places both')
    assert.equal(southEast(1), undefined, 'with one it planned both, and the bot ran out halfway')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('the scaffolding the reserve leaves is not planned: a tower needs its blocks and the reserve', async () => {
  const rig = rigWith(4)
  try {
    // a 1x1 tower of one block up needs one block over the reserve of 4
    let last: any
    for await (const res of rig.bot.pathfinder.getPathTo(new goals.GoalBlock(0, 65, 0))) last = res.result
    assert.notEqual(last.status, 'success')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto searches again when the blocks it holds no longer cover the rest of its bridge (used or dropped on the way)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  const Item = require('prismarine-item')('1.20.4')
  const stack = new Item(rig.mcData.itemsByName.cobblestone.id, 8)
  stack.slot = 36
  ;(rig.bot.inventory as any).slots[36] = stack
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTimeoutMs: 500 } }))
  try {
    lavaStrip(rig as any, 3, 200)
    // three to place of a budget of four; once the first is down, the bot has one left (the rest gone elsewhere)
    let places = 0
    ;(rig.bot as any).on('blockPlaced', () => { if (++places === 1) stack.count = 1 })
    const failed: string[] = []
    rig.bot.on('pathfinderMoveFailed' as any, (info: any) => failed.push(String(info?.error)))
    let lowest = rig.bot.entity.position.y
    rig.bot.on('physicsTick', () => { lowest = Math.min(lowest, rig.bot.entity.position.y) })
    await rig.bot.pathfinder.goto(new goals.GoalBlock(6, 64, 0)).catch(() => {})
    assert.equal(places, 1, 'it went on bridging with the blocks it no longer had')
    assert.deepEqual(failed.filter(e => /no item to place/.test(e)), [])
    assert.ok(lowest >= 64 - 1e-6, `the bot fell (to y ${lowest})`)
    assert.equal(stack.count, 1)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('goto goes on over its bridge when the bot picks blocks up on the way (the plan still fits)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  const Item = require('prismarine-item')('1.20.4')
  const stack = new Item(rig.mcData.itemsByName.cobblestone.id, 8)
  stack.slot = 36
  ;(rig.bot.inventory as any).slots[36] = stack
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTimeoutMs: 500 } }))
  try {
    lavaStrip(rig as any, 3, 200)
    let places = 0
    ;(rig.bot as any).on('blockPlaced', () => { if (++places === 1) stack.count += 16 })
    const resets: string[] = []
    rig.bot.on('pathfinderMoveFailed' as any, (info: any) => resets.push(String(info?.error)))
    const goal = new goals.GoalBlock(6, 64, 0)
    await rig.bot.pathfinder.goto(goal)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `goto ended at ${at}`)
    assert.equal(places, 3)
    assert.deepEqual(resets, [])
  } finally {
    rig.stopPassivePhysics()
  }
})
