import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { StraightUpExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { createCacheWorld } from './setup'

test('a StraightUp off its block\'s middle walks to it facing the way it turns: the turn is the bot\'s look (its yawDegrees, which mineflayer\'s physics moves by), not its entity.yaw alone', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  try {
    // facing away from the middle (west, yaw pi / 2), 0.2 off it to the north-west: the box at the block's corner
    rig.bot.entity.position = new Vec3(0.3, 64, 0.3)
    await rig.bot.look(Math.PI / 2, 0, true)
    const move: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(0.5, 65, 0.5), toPlace: [], toBreak: [] }
    const executor = new StraightUpExecutor(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.defaultMoveSettings)
    executor.loadMove(move)
    const ticks = await new Promise<number>((resolve) => {
      let n = 0
      const listener = (): void => {
        void executor.align(move).then((aligned) => {
          if (aligned || ++n >= 40) {
            rig.bot.off('physicsTick', listener)
            rig.bot.clearControlStates()
            resolve(n)
          }
        })
      }
      rig.bot.on('physicsTick', listener)
    })
    const at = rig.bot.entity.position
    // it pressed forward the way it faced before the turn, into the corner, until the no-progress check
    assert.ok(ticks < 40, `not centred after ${ticks} ticks, at ${at}`)
    assert.ok(at.xzDistanceTo(new Vec3(0.5, 64, 0.5)) <= 0.2, `at ${at}`)
    // what the bot turned to is what it sends and moves by
    const conv = require('mineflayer/lib/conversions')
    const sent = conv.fromNotchianYaw(Number((rig.bot.entity as any).yawDegrees))
    const diff = Math.abs(Math.atan2(Math.sin(sent - rig.bot.entity.yaw), Math.cos(sent - rig.bot.entity.yaw)))
    assert.ok(diff < 1e-3, `yaw ${rig.bot.entity.yaw} against yawDegrees ${String((rig.bot.entity as any).yawDegrees)}`)
  } finally {
    rig.stopPassivePhysics()
  }
})
