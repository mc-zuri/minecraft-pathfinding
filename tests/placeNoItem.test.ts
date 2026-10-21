import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { PlaceHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

test('a place with no block in the hand (its equip failed, the block thrown from the bag) fails at once: no place, no predicted block in the client\'s world, the handler free to equip again', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const bot: any = rig.bot
  try {
    const cell = new Vec3(0, 64, 1)
    const handler = PlaceHandler.fromVec(cell, 'solid')
    ;(handler as any).move = { settings: bot.pathfinder.defaultMoveSettings }
    let places = 0
    bot._placeBlockWithOptions = async () => { places++; throw new Error('must be holding an item to place') }
    // the bag's cobblestone gone since the handler picked it: the equip throws, the hand stays empty
    bot.equip = async () => { throw new Error('Invalid item object in equip') }
    bot.inventory.items = () => []
    const before = bot.blockAt(cell)?.name
    const cobble = { name: 'cobblestone', type: bot.registry.itemsByName.cobblestone.id, count: 1, slot: 36 }
    await assert.rejects(handler.perform(bot, cobble as any), /no block in hand|Invalid item object/)
    assert.equal(places, 0)
    assert.equal(bot.blockAt(cell)?.name, before)
    // the failed equip let the handler go: the next equip is tried, not skipped
    let equips = 0
    bot.equip = async () => { equips++ }
    await handler.equipItem(bot, cobble as any)
    assert.equal(equips, 1)
  } finally {
    rig.stopPassivePhysics()
  }
})
