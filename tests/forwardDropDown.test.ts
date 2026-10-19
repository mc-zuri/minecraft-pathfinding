import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { Move } from '../src/mineflayer-specific/move'
import { ForwardDropDown } from '../src/mineflayer-specific/movements/movementProviders'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

test('a ForwardDropDown of two blocks that starts while the bot aligns, at the ledge already, lands on its exit', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  const failed: string[] = []
  rig.bot.on('pathfinderMoveFailed' as any, (info: any) => failed.push(String(info?.error)))
  try {
    // a terrace two blocks down beyond z 0: the ground at z -1 and on is at y 61 (stand at 62)
    for (let x = -3; x <= 3; x++) for (let z = -4; z <= -1; z++) {
      for (const y of [62, 63]) world.setBlock(new Vec3(x, y, z), 'air')
      world.setBlock(new Vec3(x, 61, z), 'stone')
    }
    // a 1.21.11 play run's state (seed 7): come down a step onto the entry's block, past its middle, walking on to the
    // ledge, so the bot walked off it before the align's box check held, and the drop under way was 'too low'
    rig.bot.entity.position = new Vec3(0.5168, 64, 0.026)
    rig.bot.entity.velocity = new Vec3(0.0033, -0.0784, -0.0703)
    rig.bot.entity.onGround = true
    void rig.bot.look(0.021, 0, true)
    const provider = new ForwardDropDown(rig.bot as any, rig.bot.pathfinder.world, rig.bot.pathfinder.defaultMoveSettings)
    const start = Move.startMove(provider, new Vec3(0.5, 64, 0.5), new Vec3(0, 0, 0), 1000)
    const move = Move.fromPrevious(11.494, new Vec3(0.5, 62, -0.5), start, provider)
    const goal = new goals.GoalBlock(0, 62, -1)
    await withTimeout(rig.bot.pathfinder.perform({ path: [move], status: 'success' } as any, goal), 20000, `timed out at ${rig.bot.entity.position}`)
    const at = rig.bot.entity.position
    assert.deepEqual(failed, [])
    assert.ok(goal.isEnd({ x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) } as any), `ended at ${at}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a drop of two off a platform two high, three wide, is a ForwardDropDown to the floor (the rig\'s level bottom is the dimension\'s, not the floor)', { timeout: 30000 }, async () => {
  // the flat floor's top at 63 (the feet at 64), a platform x -2 to 2, z 0 to 2, two blocks high on it (the feet at 66)
  const { rig } = createCacheWorld('1.21.11', 64, new Vec3(0.5, 66, 1.5))
  const bot: any = rig.bot
  try {
    for (let x = -2; x <= 2; x++) for (let z = 0; z <= 2; z++) for (const y of [64, 65]) bot.world.setBlock(new Vec3(x, y, z), 'stone')
    // as mineflayer's login packet gives it: the overworld's min_y
    assert.equal(bot.game.minY, -64)
    bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 8000 } } as any))
    const settings = { ...bot.pathfinder.defaultMoveSettings, canDig: false, canPlace: false }
    bot.pathfinder.setMoveOptions(settings)
    // the provider's own landing: from the platform's -z edge, the cell over the floor two blocks down
    const provider = new ForwardDropDown(bot, bot.pathfinder.world, settings)
    const start = Move.startMove(provider, new Vec3(0.5, 66, 0.5), new Vec3(0, 0, 0), 1000)
    const out: Move[] = []
    provider.provideMovements(start, out, new goals.GoalBlock(0, 64, -4), new Set())
    assert.deepEqual(out.map(m => `${m.x},${m.y},${m.z}`), ['0,64,-1'])
    for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
    await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(0, 64, -4)), 20000, `timed out at ${bot.entity.position}`)
    // (before: no path, the bot still on the platform at (0.5, 66, 1.5))
    assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 64, -3.5)) < 1.2, `at ${bot.entity.position.toString()}`)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a drop of maxDropDown (3) off a platform is a ForwardDropDown, one of 4 is none (the fall is to the feet, on top of the ground\'s block)', { timeout: 30000 }, async () => {
  for (const [height, landings] of [[3, ['0,64,-1']], [4, []]] as const) {
    // a platform x -2 to 2, z 0 to 2, `height` blocks high on the floor (the feet on it at 64 + height)
    const { rig } = createCacheWorld('1.21.11', 64, new Vec3(0.5, 64 + height, 1.5))
    const bot: any = rig.bot
    try {
      for (let x = -2; x <= 2; x++) for (let z = 0; z <= 2; z++) for (let y = 64; y < 64 + height; y++) bot.world.setBlock(new Vec3(x, y, z), 'stone')
      bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false, searchTimeoutMs: 8000 } } as any))
      const settings = { ...bot.pathfinder.defaultMoveSettings, canDig: false, canPlace: false }
      assert.equal(settings.maxDropDown, 3)
      bot.pathfinder.setMoveOptions(settings)
      const provider = new ForwardDropDown(bot, bot.pathfinder.world, settings)
      const start = Move.startMove(provider, new Vec3(0.5, 64 + height, 0.5), new Vec3(0, 0, 0), 1000)
      const out: Move[] = []
      provider.provideMovements(start, out, new goals.GoalBlock(0, 64, -4), new Set())
      // (before: none off a platform 3 high, the limit taken to the ground's block, a fall of 2)
      assert.deepEqual(out.map(m => `${m.x},${m.y},${m.z}`), landings, `${height} high`)
      if (height === 3) {
        for (let i = 0; i < 40 && bot.entity.onGround !== true; i++) await new Promise(resolve => setTimeout(resolve, 50))
        await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(0, 64, -4)), 20000, `timed out at ${bot.entity.position}`)
        assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 64, -3.5)) < 1.2, `at ${bot.entity.position.toString()}`)
      }
    } finally {
      rig.stopPassivePhysics()
    }
  }
})
