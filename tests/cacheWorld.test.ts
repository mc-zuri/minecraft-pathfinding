import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createCacheWorld } from './setup'

test('the block cache forgets the old level on a world switch (mineflayer unloads its columns without blockUpdates)', () => {
  const { world, rig, cacheWorld } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { trackRenderDistance: false })
  try {
    const pos = new Vec3(3, 63, 3)
    assert.equal(cacheWorld.getBlockInfo(pos).physical, true)
    // the other level has air there; the column changes under the cache without an event
    const chunk = (world as any).sync.getColumnAt(pos)
    chunk.setBlockStateId(new Vec3(3, 63, 3), 0)
    assert.equal(cacheWorld.getBlockInfo(pos).physical, true, 'still the cached stone before the switch')
    rig.bot.emit('worldSwitch')
    assert.equal(cacheWorld.getBlockInfo(pos).physical, false)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a pathfinder loaded before the bot logs in (no bot.world yet: mineflayer makes it on the login packet) reads the world made after', () => {
  const { world, rig } = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5), { trackRenderDistance: false })
  const bot: any = rig.bot
  try {
    // as at createBot: the blocks plugin has no world, the game no level
    bot.world = undefined
    const minY = bot.game.minY
    bot.game.minY = undefined
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createPlugin } = require('../src')
    bot.loadPlugin(createPlugin())
    // the login packet
    bot.world = world
    bot.game.minY = minY
    const cache = bot.pathfinder.world
    const pos = new Vec3(3, 63, 3)
    assert.equal(cache.getBlockInfo(pos).physical, true)
    assert.equal(cache.minY, minY)
    // a block change comes on the bot (blocks.js' proxy of the world's events) and updates what's cached
    const chunk = (world as any).sync.getColumnAt(pos)
    chunk.setBlockStateId(new Vec3(3, 63, 3), 0)
    bot.emit('blockUpdate', null, world.getBlock(pos))
    assert.equal(cache.getBlockInfo(pos).physical, false)
  } finally {
    rig.stopPassivePhysics()
  }
})
