import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, DEFAULT_SCAFFOLDING_BLOCKS, goals } from '../src'
import { Move } from '../src/mineflayer-specific/move'
import { getScaffoldCount } from '../src/utils'
import { createCacheWorld } from './setup'

// The blocks the bot builds with are a setting (scaffoldingBlocks, cheapest first). The pathfinder placed dirt and
// cobblestone only, and the nether has neither: the e2e runs topped the bot up to 64 netherrack for its bridges, the
// search's budget counted none of them, and the bot bridged with the few cobblestone it had.

/** a 26.3 bot holding `stacks` (item name, count) from hotbar slot 0 on, with the pathfinder's `moveSettings` */
function rigWith (stacks: Array<[string, number]>, moveSettings: Record<string, unknown> = {}, version = '26.3') {
  const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  const Item = require('prismarine-item')(version)
  stacks.forEach(([name, count], i) => {
    const stack = new Item(rig.mcData.itemsByName[name].id, count)
    stack.slot = 36 + i
    ;(rig.bot.inventory as any).slots[36 + i] = stack
  })
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTimeoutMs: 1500 } as any, moveSettings: moveSettings as any }))
  return rig
}

/** a strip of lava `width` blocks wide east of the bot, `span` blocks either way, nothing under it */
function lavaStrip (rig: ReturnType<typeof rigWith>, width: number, span = 200): void {
  const world = (rig.bot as any).world
  for (let x = 2; x < 2 + width; x++) for (let z = -span; z <= span; z++) world.setBlock(new Vec3(x, 63, z), 'lava')
}

async function search (rig: ReturnType<typeof rigWith>, goal: goals.Goal): Promise<{ status: string, path: Move[] }> {
  let last: any
  for await (const res of rig.bot.pathfinder.getPathTo(goal)) last = res.result
  return last
}

const count = (rig: ReturnType<typeof rigWith>, name: string): number =>
  rig.bot.inventory.items().filter((i: any) => i.name === name).reduce((n: number, i: any) => n + i.count, 0)

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: the default scaffolding is full solid blocks that don't fall, cheapest first`, () => {
    const mcData = require('minecraft-data')(version)
    const Block = require('prismarine-block')(version)
    const falling = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*concrete_powder|.*anvil|dragon_egg|scaffolding|pointed_dripstone)$/
    for (const name of DEFAULT_SCAFFOLDING_BLOCKS) {
      if (mcData.itemsByName[name] == null) continue // (poplar from 26.3)
      const block = mcData.blocksByName[name]
      assert.ok(block != null, `${name} is a block`)
      assert.ok(!falling.test(name) && !/leaves$/.test(name), `${name} falls or decays`)
      for (let state = block.minStateId; state <= block.maxStateId; state++) {
        assert.deepEqual(Block.fromStateId(state, 0).shapes, [[0, 0, 0, 1, 1, 1]], `${name} state ${state} is a full cube`)
      }
    }
    assert.deepEqual(DEFAULT_SCAFFOLDING_BLOCKS.slice(0, 3), ['dirt', 'coarse_dirt', 'netherrack'])
    assert.ok(DEFAULT_SCAFFOLDING_BLOCKS.indexOf('cobblestone') < DEFAULT_SCAFFOLDING_BLOCKS.indexOf('oak_planks'))
  })
}

test('26.3: a bridge over lava with netherrack alone: the search plans it, and goto places the netherrack', async () => {
  const rig = rigWith([['netherrack', 16]])
  try {
    lavaStrip(rig, 3)
    const placed: string[] = []
    ;(rig.bot as any).on('blockPlaced', (_old: any, block: any) => placed.push(block?.name))
    const goal = new goals.GoalBlock(6, 64, 0)
    await rig.bot.pathfinder.goto(goal)
    const at = rig.bot.entity.position
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `goto ended at ${at}`)
    for (let x = 2; x < 5; x++) assert.equal((rig.bot as any).blockAt(new Vec3(x, 63, 0)).name, 'netherrack')
    assert.equal(count(rig, 'netherrack'), 13)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('26.3: the search\'s budget counts the netherrack: ten (less the reserve, six) bridge five blocks of lava, eight don\'t', async () => {
  // (the bridge's cells by the lava cost no more than others here, edgeHazardCost 0: the search ends well inside its time)
  const enough = rigWith([['netherrack', 10]], { edgeHazardCost: 0 })
  try {
    assert.equal(getScaffoldCount(enough.bot as any, enough.bot.pathfinder.defaultMoveSettings), 10)
    lavaStrip(enough, 5, 60)
    const res = await search(enough, new goals.GoalBlock(8, 64, 0))
    assert.equal(res.status, 'success')
    assert.equal(res.path.reduce((n, m) => n + m.toPlace.length, 0), 5)
  } finally {
    enough.stopPassivePhysics()
  }
  const short = rigWith([['netherrack', 8]], { edgeHazardCost: 0 })
  try {
    lavaStrip(short, 5, 60)
    const res = await search(short, new goals.GoalBlock(8, 64, 0))
    assert.notEqual(res.status, 'success')
  } finally {
    short.stopPassivePhysics()
  }
})

test('26.3: a place takes the cheapest scaffolding held: the netherrack before the cobblestone', async () => {
  const rig = rigWith([['cobblestone', 16], ['netherrack', 16]])
  try {
    lavaStrip(rig, 2)
    await rig.bot.pathfinder.goto(new goals.GoalBlock(5, 64, 0))
    assert.equal((rig.bot as any).blockAt(new Vec3(2, 63, 0)).name, 'netherrack')
    assert.equal((rig.bot as any).blockAt(new Vec3(3, 63, 0)).name, 'netherrack')
    assert.equal(count(rig, 'cobblestone'), 16)
    assert.equal(count(rig, 'netherrack'), 14)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('26.3: the scaffolding is a setting: a list without netherrack leaves it out of the budget and the places', async () => {
  const rig = rigWith([['netherrack', 16], ['cobblestone', 6]], { scaffoldingBlocks: ['cobblestone'] })
  try {
    assert.deepEqual(rig.bot.pathfinder.defaultMoveSettings.scaffoldingBlocks, ['cobblestone'])
    assert.equal(getScaffoldCount(rig.bot as any, rig.bot.pathfinder.defaultMoveSettings), 6)
    lavaStrip(rig, 3, 60)
    // a budget of two (six less the reserve of four): three blocks of lava aren't bridged
    const res = await search(rig, new goals.GoalBlock(6, 64, 0))
    assert.notEqual(res.status, 'success')
    // with the list set again, the netherrack counts
    rig.bot.pathfinder.setMoveOptions({ ...rig.bot.pathfinder.defaultMoveSettings, scaffoldingBlocks: ['netherrack', 'cobblestone'] })
    assert.equal(getScaffoldCount(rig.bot as any, rig.bot.pathfinder.defaultMoveSettings), 22)
    assert.equal((await search(rig, new goals.GoalBlock(6, 64, 0))).status, 'success')
  } finally {
    rig.stopPassivePhysics()
  }
})
