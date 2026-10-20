import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

// A drop into water deeper than maxDropDown (infiniteLiquidDropdownDistance) is the water's only for a box that falls
// clear of ground the whole way: a ledge in a column beside the fall's catches a box drifted off its middle short of
// the water. A 26.3 bot's planned ForwardDropDown of 42 into a cave's water came down on a ledge at y 29 and died
// (full-26.3-fresh-s); its breaks were planned in the column beyond the landing's (the head room checked a column on).

async function plan (bot: any, goal: goals.Goal): Promise<any> {
  let final: any
  for await (const res of bot.pathfinder.getPathTo(goal)) final = res
  return final.result
}

/** a 3x3 pit (x 1..3, z -1..1) from the floor (y 63) down to water at y 22, with ledges at y 28 round it when `ledges` */
function pitRig (ledges: boolean) {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0.5, 64, 0.5)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTimeoutMs: 1500 } as any }))
  const world = (rig.bot as any).world
  for (let x = 0; x <= 4; x++) {
    for (let z = -2; z <= 2; z++) {
      const pit = x >= 1 && x <= 3 && z >= -1 && z <= 1
      if (pit) {
        world.setBlock(new Vec3(x, 63, z), 'air')
        world.setBlock(new Vec3(x, 21, z), 'stone')
        world.setBlock(new Vec3(x, 22, z), 'water')
      } else if (ledges) {
        // ground jutting under the pit's rim, a block of air over it
        world.setBlock(new Vec3(x, 28, z), 'stone')
      }
    }
  }
  rig.bot.pathfinder.setMoveOptions({ canDig: false, canPlace: false })
  return rig
}

test('a drop of 41 into water down a pit clear of ledges is planned', async () => {
  const rig = pitRig(false)
  try {
    const result = await plan(rig.bot, new goals.GoalBlock(2, 22, 0))
    assert.equal(result.status, 'success')
    const drop = result.path.find((m: any) => m.entryPos.y - m.exitPos.y > 3)
    assert.ok(drop != null, result.path.map((m: any) => m.exitPos.toString()).join(' '))
    assert.equal(drop.exitPos.y, 22)
    // no break planned beside the landing (its head room is in its own column, clear)
    assert.equal(drop.toBreak.length, 0)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a drop into water past ledges beside the fall is not planned', async () => {
  const rig = pitRig(true)
  try {
    const result = await plan(rig.bot, new goals.GoalBlock(2, 22, 0))
    const deep = (result.path ?? []).filter((m: any) => m.entryPos.y - m.exitPos.y > 3)
    assert.equal(deep.length, 0, `a drop past the ledges: ${deep.map((m: any) => `${m.entryPos.toString()}>${m.exitPos.toString()}`).join(' ')}`)
    assert.notEqual(result.status, 'success')
  } finally {
    rig.stopPassivePhysics()
  }
})
