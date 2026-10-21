import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { createCacheWorld } from './setup'

// A walk down a slope of steps ending at a deep drop: each step down within the allowed drop, the bot's own keys
// (a chase's steering: forward and sprint) held all the way. The guard followed a walk's fall with the keys let go, the
// fall a short one onto the next step, while the keys held carried the bot two steps down onto the drop's brink, and
// off it: a 26.3 bot hunting a cow on the steep dirt slope of a sinkhole's lip ran down it and fell 49 blocks into the
// hole (f1-26.3, t8914).

/**
 * along +x: the floor at y 63 (the feet at 64) to x 4, steps down of 2 (the feet at 62 for x 5..6, 60 at x 7, 58 at
 * x 8), then a drop to the stone at y 9 for x 9..14; z -3..3 the same
 */
function slopeRig (version: string) {
  const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { edgeGuard: 'always' } } as any))
  const bot: any = rig.bot
  const feet = (x: number): number => x <= 4 ? 64 : x <= 6 ? 62 : x === 7 ? 60 : x === 8 ? 58 : 10
  for (let x = 5; x <= 14; x++) {
    for (let z = -3; z <= 3; z++) {
      for (let y = 9; y <= 63; y++) bot.world.setBlock(new Vec3(x, y, z), y < feet(x) ? 'stone' : 'air')
    }
  }
  return { rig, bot }
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: a sprint down a slope of 2-block steps, its keys held, is held on the slope short of the deep drop at its foot (f1-26.3: 49 blocks into a sinkhole)`, async () => {
    const { rig, bot } = slopeRig(version)
    let lowest = Infinity
    let catches = 0
    bot.on('edgeGuard', () => { catches++ })
    try {
      await bot.waitForTicks(4)
      bot.entity.position = new Vec3(0.5, 64, 0.5)
      for (let t = 0; t < 80; t++) {
        await bot.look(-Math.PI / 2, 0, true)
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        await bot.waitForTicks(1)
        lowest = Math.min(lowest, bot.entity.position.y)
      }
      assert.ok(lowest >= 55, `the bot fell to ${lowest.toFixed(1)} (at ${bot.entity.position.toString()})`)
      assert.ok(catches > 0)
      assert.ok(bot.entity.position.x < 9, `at ${bot.entity.position.toString()}`)
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
