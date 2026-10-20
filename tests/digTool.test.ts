import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { NewForwardExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

// The dig's tool is the one the inventory holds now. PathingUtil memoed the best tool for each block type from the
// inventory at the path's start, and mineflayer's equip takes an item by its slot (simple_inventory's equip:
// item.slot): a tool moved since left its old slot to something else, and the dig equipped that. A 26.3 bot with a
// stone pickaxe dug granite holding one cobblestone, some 150 ticks a block, 'no arrival in 5000 ticks' on a dug way.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a dig equips the tool where it is now, not at the slot it had when the path was planned`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const pos = new Vec3(1, 64, 0)
    bot.world.setBlock(pos, 'granite')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      const Item = require('prismarine-item')(version)
      const put = (slot: number, name: string, count = 1): any => {
        const item = new Item(rig.mcData.itemsByName[name].id, count)
        item.slot = slot
        bot.inventory.slots[slot] = item
        return item
      }
      put(38, 'stone_pickaxe')
      put(20, 'cobblestone')
      bot.pathingUtil.refresh()
      // the search's dig cost: the best tool memoed
      assert.equal(bot.pathingUtil.bestHarvestingTool(bot.blockAt(pos))?.name, 'stone_pickaxe')
      // the hotbar slot given to the cobblestone, the pickaxe put where it was (the server's set_slot: new items)
      put(38, 'cobblestone')
      put(20, 'stone_pickaxe')
      // mineflayer's equip: the item's slot, a hotbar slot selected, another one moved into the hand
      bot.equip = async (item: any) => {
        const source = item.slot
        if (source >= 36 && source < 45) bot.setQuickBarSlot(source - 36)
        else {
          const hand = 36 + bot.quickBarSlot
          const held = bot.inventory.slots[hand]
          bot.inventory.slots[hand] = bot.inventory.slots[source]
          bot.inventory.slots[source] = held
          if (bot.inventory.slots[hand] != null) bot.inventory.slots[hand].slot = hand
          if (held != null) held.slot = source
        }
        bot.updateHeldItem()
      }
      let digWith: string | undefined
      const dig = bot.dig.bind(bot)
      bot.dig = async (...args: any[]) => { digWith = bot.heldItem?.name; return await dig(...args) }
      const handler = BreakHandler.fromVec(pos, 'solid')
      const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 64, 0.5), toPlace: [], toBreak: [handler] }
      const executor = new NewForwardExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      executor.loadMove(move)
      await withTimeout(executor.performInteraction(handler), 8000, 'the break never ended')
      assert.equal(digWith, 'stone_pickaxe')
      assert.equal(bot.blockAt(pos).name, 'air')
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: a tool got after the path was planned is the one a dig holds, not the bare hand`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const pos = new Vec3(1, 64, 0)
    bot.world.setBlock(pos, 'dirt')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      // the plan's inventory: no tool, the dig cost by hand memoed
      bot.pathingUtil.refresh()
      bot.pathingUtil.digCost(bot.blockAt(pos))
      // a shovel given since, held
      const Item = require('prismarine-item')(version)
      const shovel = new Item(rig.mcData.itemsByName.stone_shovel.id, 1)
      shovel.slot = 36
      bot.inventory.slots[36] = shovel
      bot.updateHeldItem()
      let digWith: string | undefined
      const dig = bot.dig.bind(bot)
      bot.dig = async (...args: any[]) => { digWith = bot.heldItem?.name; return await dig(...args) }
      const handler = BreakHandler.fromVec(pos, 'solid')
      const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 64, 0.5), toPlace: [], toBreak: [handler] }
      const executor = new NewForwardExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      executor.loadMove(move)
      await withTimeout(executor.performInteraction(handler), 8000, 'the break never ended')
      assert.equal(digWith, 'stone_shovel')
      assert.equal(bot.inventory.slots[36]?.name, 'stone_shovel', 'the shovel stays in the hotbar')
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: a dig's tool that is gone from the inventory gives way to the inventory's tools now`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    try {
      const Item = require('prismarine-item')(version)
      const put = (slot: number, name: string | null): void => {
        if (name == null) { bot.inventory.slots[slot] = null; return }
        const item = new Item(rig.mcData.itemsByName[name].id, 1)
        item.slot = slot
        bot.inventory.slots[slot] = item
      }
      bot.world.setBlock(new Vec3(1, 64, 0), 'stone')
      put(36, 'iron_pickaxe')
      put(37, 'wooden_pickaxe')
      bot.pathingUtil.refresh()
      const stone = bot.blockAt(new Vec3(1, 64, 0))
      assert.equal(bot.pathingUtil.bestHarvestingTool(stone)?.name, 'iron_pickaxe')
      // the iron pickaxe broke
      put(36, null)
      const tool = bot.pathingUtil.bestHarvestingTool(stone)
      assert.equal(tool?.name, 'wooden_pickaxe')
      assert.equal(tool, bot.inventory.slots[37])
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
