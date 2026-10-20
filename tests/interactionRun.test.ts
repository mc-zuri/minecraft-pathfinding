import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin } from '../src'
import { NewForwardJumpExecutor } from '../src/mineflayer-specific/movements/movementExecutors'
import { BreakHandler } from '../src/mineflayer-specific/movements/interactionUtils'
import { AbortError } from '../src/mineflayer-specific/exceptions'
import { createCacheWorld } from './setup'

// A walk that ends (the move failed: a ForwardJump whose start, its digs one after another, took over its ticks; goto
// ended) stops its digs, and its start goes no further. Left on, a 26.3 bot's ForwardJump given up on after 204 ticks
// of its start dug on beside the next path's moves, which run on the same executor (one for each kind of move):
// mineflayer ends a dig when another is asked for ('Digging aborted'), and the old dig's failure failed the new move
// ('interaction failed: ... Digging aborted') as the new move's block broke.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

for (const version of ['26.3', '1.21.11']) {
  test(`${version}: the digs of a walk that ended stop, and the next move's dig fails nothing`, async () => {
    const rig = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
    rig.bot.loadPlugin(createPlugin())
    const bot: any = rig.bot
    // the old move's blocks: dirt by hand, some 15 ticks each; the new move's to the south
    const a1 = new Vec3(1, 65, 0)
    const a2 = new Vec3(1, 64, 0)
    const b = new Vec3(0, 65, 1)
    for (const pos of [a1, a2, b]) bot.world.setBlock(pos, 'dirt')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    bot.entity.onGround = true
    try {
      const executor: any = new NewForwardJumpExecutor(bot, bot.pathfinder.world, bot.pathfinder.defaultMoveSettings)
      const dug: string[] = []
      const dig = bot.dig.bind(bot)
      bot.dig = async (block: any, ...args: any[]) => { dug.push(block.position.toString()); return await dig(block, ...args) }

      const moveA: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(1.5, 65, 0.5), toPlace: [], toBreak: [BreakHandler.fromVec(a1, 'solid'), BreakHandler.fromVec(a2, 'solid')] }
      executor.loadMove(moveA)
      // the start's digs, one after another (ForwardJumpExecutor.performInit)
      const initA = (async () => { for (const h of moveA.toBreak) await executor.performInteraction(h) })()
      initA.catch(() => {})
      await bot.waitForTicks(4)
      assert.equal(bot.targetDigBlock?.position?.toString(), a1.toString(), 'the first dig is under way')
      // the move given up on: the walk ends (PathExecutor's executorSafeReset)
      executor.reset()

      const moveB: any = { entryPos: new Vec3(0.5, 64, 0.5), exitPos: new Vec3(0.5, 65, 1.5), toPlace: [], toBreak: [BreakHandler.fromVec(b, 'solid')] }
      executor.loadMove(moveB)
      await withTimeout(executor.performInteraction(moveB.toBreak[0]), 8000, 'the new dig never ended')
      await bot.waitForTicks(30)

      await assert.rejects(initA, AbortError)
      assert.equal(bot.blockAt(b).name, 'air')
      assert.equal(bot.blockAt(a2).name, 'dirt', 'the old start dug no further')
      assert.deepEqual(dug.filter(p => p !== a1.toString()), [b.toString()])
      // the new move's next tick: no failure of the old move's dig
      assert.doesNotThrow(() => executor.throwIfInteractionFailed())
    } finally {
      rig.stopPassivePhysics()
    }
  })
}
