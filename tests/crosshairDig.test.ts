import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, digInSight } from '../src'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

function rigWith (blocks: Array<[number, number, number, string]>): ReturnType<typeof createCacheWorld>['rig'] {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin())
  const world = (rig.bot as any).world
  for (const [x, y, z, name] of blocks) world.setBlock(new Vec3(x, y, z), name)
  rig.bot.entity.position = new Vec3(0.5, 64, 0.5)
  return rig
}

test('a log behind a leaf is dug as vanilla\'s player digs it: the leaf the crosshair hits first, then the log', async () => {
  const rig = rigWith([[2, 65, 0, 'oak_leaves'], [3, 65, 0, 'oak_log']])
  const bot: any = rig.bot
  try {
    const broken: string[] = []
    bot.on('diggingCompleted', (b: any) => broken.push(b.position.toString()))
    await withTimeout(digInSight(bot, bot.blockAt(new Vec3(3, 65, 0))), 20000, 'dig timed out')
    assert.equal(bot.blockAt(new Vec3(2, 65, 0)).name, 'air')
    assert.equal(bot.blockAt(new Vec3(3, 65, 0)).name, 'air')
    assert.deepEqual(broken, [new Vec3(2, 65, 0).toString(), new Vec3(3, 65, 0).toString()])
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a log seen around a leaf is dug through the face in sight, the leaf left', async () => {
  const rig = rigWith([[2, 65, 0, 'oak_leaves'], [3, 65, 1, 'oak_log']])
  const bot: any = rig.bot
  try {
    await withTimeout(digInSight(bot, bot.blockAt(new Vec3(3, 65, 1))), 20000, 'dig timed out')
    assert.equal(bot.blockAt(new Vec3(2, 65, 0)).name, 'oak_leaves')
    assert.equal(bot.blockAt(new Vec3(3, 65, 1)).name, 'air')
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a dig stops when a block comes into the crosshair\'s way, and that block is broken before the target', async () => {
  const rig = rigWith([[3, 65, 0, 'stone']])
  const bot: any = rig.bot
  const world = bot.world
  try {
    const broken: string[] = []
    bot.on('diggingCompleted', (b: any) => broken.push(b.position.toString()))
    let ticks = 0
    // a few ticks into the stone's dig (150 ticks by hand), a leaf in front of it
    const onTick = (): void => { if (++ticks === 5) world.setBlock(new Vec3(2, 65, 0), 'oak_leaves') }
    bot.on('physicsTick', onTick)
    await withTimeout(digInSight(bot, bot.blockAt(new Vec3(3, 65, 0))), 30000, 'dig timed out')
    bot.off('physicsTick', onTick)
    assert.deepEqual(broken, [new Vec3(2, 65, 0).toString(), new Vec3(3, 65, 0).toString()])
  } finally {
    rig.stopPassivePhysics()
  }
})
