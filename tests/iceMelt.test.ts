import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { BlockInfo } from '../src/mineflayer-specific/world/cacheWorld'
import { createCacheWorld } from './setup'

// IceBlock.playerDestroy: broken over a liquid or a block that blocks motion, ice turns to water (meltsInto); over air
// it is gone. Packed and blue ice never melt. (BlockInfo's block sets are filled once a process, from the first
// registry: the other tests' 1.20.4)
test('ice over water or the ground floods its cell when broken (waterAround: not safe to break), over air it does not', () => {
  for (const version of ['1.20.4']) {
    const { world, rig } = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5))
    try {
      const info = (pos: Vec3): BlockInfo => BlockInfo.fromBlock(world.getBlock(pos) as any)
      const movement: any = {
        settings: { dontCreateFlow: true, dontMineUnderFallingBlock: false },
        getBlockInfo: (pos: Vec3, dx: number, dy: number, dz: number) => info(pos.offset(dx, dy, dz))
      }
      const iceOver = (below: string, ice = 'ice'): boolean => {
        const at = new Vec3(3, 70, 3)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) world.setBlock(at.offset(dx, 0, dz), 'air')
        world.setBlock(at.offset(0, 1, 0), 'air')
        world.setBlock(at.offset(0, -1, 0), below)
        world.setBlock(at, ice)
        const block = info(at)
        block.loadAdditionalInfo(movement)
        return block.waterAround
      }
      assert.equal(iceOver('water'), true, `${version}: ice over water`)
      assert.equal(iceOver('stone'), true, `${version}: ice over stone`)
      assert.equal(iceOver('air'), false, `${version}: ice over air`)
      assert.equal(iceOver('water', 'packed_ice'), false, `${version}: packed ice over water`)
    } finally {
      rig.stopPassivePhysics()
    }
  }
})
