import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { NewForwardJumpExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

// A break the client predicts and the server refuses: mineflayer's dig ends on the block's change to air (the client's
// prediction, MultiPlayerGameMode.destroyBlock), and the server's acknowledgement of the action puts the block back
// (BlockStatePredictionHandler.endPredictionsUpTo). On 26.3 runs the bot equipped its shears for a leaf (or an
// efficiency pickaxe for netherrack) and dug at once: the dig was an instant break by the client's held item, while the
// server, not yet told of the new slot (ensureHasSentCarriedItem, at the next tick), still held the old one and only
// started the dig. The block came back, nothing dug it again, and the jump's BreakHandler waited for air until
// 'Timed out waiting 100 ticks for waitForSettledBlockStateAtPosition' (10 of 13 ForwardJump failures on a nether run).

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** the bot's first `refusals` digs are breaks the client predicts and the server puts back the next tick */
function refusingDigs (bot: any, refusals: number): { digs: () => number } {
  const world = bot.world
  const dig = bot.dig.bind(bot)
  let digs = 0
  bot.dig = async (block: any, ...args: any[]) => {
    digs++
    if (digs > refusals) return await dig(block, ...args)
    const pos = block.position.clone()
    const stateId = block.stateId
    // the client's instant break: air at once, the dig over
    world.setBlock(pos, 'air')
    bot.emit('diggingCompleted', bot.blockAt(pos))
    // the server's acknowledgement, the next tick: the block as the server has it
    bot.once('physicsTick', () => world.setBlock(pos, stateId))
  }
  return { digs: () => digs }
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: a dug block the server puts back is dug again, the break done once it stays gone`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const pos = new Vec3(1, 65, 0)
    bot.world.setBlock(pos, 'oak_leaves')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      const { digs } = refusingDigs(bot, 1)
      const handler = BreakHandler.fromVec(pos, 'solid')
      const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 65, 0.5), toPlace: [], toBreak: [handler] }
      const executor = new NewForwardJumpExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      executor.loadMove(move)
      await withTimeout(executor.performInteraction(handler), 4000, 'the break never ended')
      assert.equal(bot.blockAt(pos).name, 'air')
      assert.equal(digs(), 2, 'the leaf the server put back was dug again')
      assert.equal(executor.toBreakLen(), 0)
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: the slot of the tool the dig equips goes to the server before the dig starts`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const pos = new Vec3(1, 65, 0)
    bot.world.setBlock(pos, 'oak_leaves')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      const Item = require('prismarine-item')(version)
      bot.inventory.slots[40] = new Item(rig.mcData.itemsByName.shears.id, 1)
      bot.pathingUtil.refresh()
      const order: string[] = []
      const equip = bot.equip.bind(bot)
      bot.equip = async (...args: any[]) => { order.push(`equip ${String(args[0]?.name)}`); return await equip(...args) }
      // mineflayer's send of a slot change, which it otherwise makes at a later tick
      bot._ensureHasSentCarriedItem = () => { if (order[order.length - 1] !== 'slot sent') order.push('slot sent') }
      const dig = bot.dig.bind(bot)
      bot.dig = async (...args: any[]) => { order.push(`dig with ${String(bot.heldItem?.name)}`); return await dig(...args) }
      const handler = BreakHandler.fromVec(pos, 'solid')
      const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 65, 0.5), toPlace: [], toBreak: [handler] }
      const executor = new NewForwardJumpExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      executor.loadMove(move)
      await withTimeout(executor.performInteraction(handler), 4000, 'the break never ended')
      assert.equal(bot.blockAt(pos).name, 'air')
      assert.deepEqual(order, ['equip shears', 'slot sent', 'dig with shears'])
    } finally {
      rig.stopPassivePhysics()
    }
  })

  test(`${version}: a block the server puts back after every dig fails the break after a few tries, not after the timeout`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    const pos = new Vec3(1, 65, 0)
    bot.world.setBlock(pos, 'oak_leaves')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      const { digs } = refusingDigs(bot, Infinity)
      const handler = BreakHandler.fromVec(pos, 'solid')
      const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 65, 0.5), toPlace: [], toBreak: [handler] }
      const executor = new NewForwardJumpExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      executor.loadMove(move)
      await assert.rejects(withTimeout(executor.performInteraction(handler), 4000, 'the break never ended'), /came back/)
      assert.equal(digs(), BreakHandler.DIG_TRIES)
      assert.equal(bot.blockAt(pos).name, 'oak_leaves')
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
