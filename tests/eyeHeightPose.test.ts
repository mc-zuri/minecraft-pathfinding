import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { createCacheWorld } from './setup'

// A break's reach is measured from the eyes of the bot's pose (Entity.getEyePosition, as the server measures it,
// ServerPlayer.canInteractWithBlock): a crouching bot's are 1.27 over its feet from 1.14, not 1.62. BreakHandler took a
// block 4.38 over the standing eyes as in reach for a crouching bot, whose eyes are 4.73 under it, and the dig started
// out of the server's reach.

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a break's reach is from the eyes of the bot's pose: in reach standing, out of it crouching, a block 4.38 over the standing eyes`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    try {
      bot.world.setBlock(new Vec3(0, 70, 0), 'stone')
      const handler = BreakHandler.fromVec(new Vec3(0, 70, 0), 'solid')
      await bot.waitForTicks(2)
      assert.equal(bot.entity.eyeHeight, 1.62)
      assert.equal((await handler.performInfo(bot)).ticks, 0)
      bot.setControlState('sneak', true)
      await bot.waitForTicks(2)
      assert.equal(bot.entity.eyeHeight, 1.27)
      assert.equal((await handler.performInfo(bot)).ticks, Infinity)
      bot.setControlState('sneak', false)
      await bot.waitForTicks(2)
      assert.equal((await handler.performInfo(bot)).ticks, 0)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
