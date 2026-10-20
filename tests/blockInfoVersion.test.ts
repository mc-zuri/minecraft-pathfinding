import assert from 'node:assert/strict'
import test from 'node:test'

import { BlockInfo } from '../src/mineflayer-specific/world/cacheWorld'
import { loadMcData } from './setup'

test('the block sets follow the version of the bot that loads the plugin: another version\'s ids are made again (a 26.3 bot after a 1.20.4 one took water\'s id for another block\'s)', () => {
  const ids = (version: string): { water: number, ladder: number } => {
    const { mcData } = loadMcData(version)
    return { water: mcData.blocksByName.water.id, ladder: mcData.blocksByName.ladder.id }
  }
  const old = ids('1.20.4')
  assert.ok(BlockInfo.waters.has(old.water) && BlockInfo.climbables.has(old.ladder))
  for (const version of ['26.3', '1.21.11', '1.20.4']) {
    const now = ids(version)
    assert.equal(BlockInfo.version, version)
    assert.ok(BlockInfo.waters.has(now.water), `${version}: water ${now.water} not a water`)
    assert.ok(BlockInfo.liquids.has(now.water))
    assert.ok(BlockInfo.climbables.has(now.ladder))
    assert.deepEqual([...BlockInfo.climbables], [now.ladder], `${version}: another version's ids left`)
  }
  assert.notEqual(ids('26.3').water, old.water, 'the versions\' water ids are the same: the test shows nothing')
})
