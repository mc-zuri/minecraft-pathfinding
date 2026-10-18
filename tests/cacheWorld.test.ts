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
