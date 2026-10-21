import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, digInSight, DigRefusedError } from '../src'
import { createCacheWorld } from './setup'

// digInSight's break waits for the server's answer: mineflayer's dig ends on the client's predicted break
// (MultiPlayerGameMode.destroyBlock, diggingCompleted), and a dig the server refused (spawn protection, a claim) has the
// block put back by its acknowledgement (BlockStatePredictionHandler.endPredictionsUpTo). digInSight resolved on the
// prediction, and its callers (mineflayer-survival's dig: a log under spawn protection) went on as if it were gone.

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/**
 * The bot's digs are breaks the client predicts that the server answers `answerTicks` ticks later: till then the block
 * is a prediction (mineflayer's _isBlockPredicted, `predictions`), then the server's block, put back when `refused`
 */
function lateAnswers (bot: any, refused: boolean, answerTicks: number, predictions = true): { digs: () => number } {
  const world = bot.world
  const pending = new Set<string>()
  bot._isBlockPredicted = predictions ? (pos: Vec3) => pending.has(pos.floored().toString()) : undefined
  let digs = 0
  bot.dig = async (block: any) => {
    digs++
    const pos = block.position.clone()
    const stateId = block.stateId
    // the dig's ticks (a leaf by hand: 6), then the client's break
    await bot.waitForTicks(6)
    world.setBlock(pos, 'air')
    pending.add(pos.toString())
    bot.emit('diggingCompleted', bot.blockAt(pos))
    void bot.waitForTicks(answerTicks).then(() => {
      pending.delete(pos.toString())
      if (refused) world.setBlock(pos, stateId)
    })
  }
  return { digs: () => digs }
}

function rig (version: string): { rig: ReturnType<typeof createCacheWorld>['rig'], bot: any, pos: Vec3 } {
  const r = createCacheWorld(version, 64, new Vec3(0.5, 64, 0.5)).rig
  r.bot.loadPlugin(createPlugin())
  const bot: any = r.bot
  const pos = new Vec3(2, 65, 0)
  bot.world.setBlock(pos, 'oak_leaves')
  bot.entity.position = new Vec3(0.5, 64, 0.5)
  bot.entity.onGround = true
  return { rig: r, bot, pos }
}

for (const version of ['26.3', '1.21.11', '1.20.4']) {
  test(`${version}: a dig the server refuses, its break put back by the answer 6 ticks later, fails DigRefusedError (before: resolved, the leaf back)`, async () => {
    const { rig: r, bot, pos } = rig(version)
    try {
      const { digs } = lateAnswers(bot, true, 6)
      await assert.rejects(withTimeout(digInSight(bot, bot.blockAt(pos)), 8000, 'the dig never ended'), (err: any) => err instanceof DigRefusedError && err.position.equals(pos) && /oak_leaves.*refused/.test(err.message))
      assert.equal(digs(), 1)
      assert.equal(bot.blockAt(pos).name, 'oak_leaves')
    } finally {
      r.stopPassivePhysics()
    }
  })

  test(`${version}: a dig the server keeps resolves once its answer leaves the block gone`, async () => {
    const { rig: r, bot, pos } = rig(version)
    try {
      const { digs } = lateAnswers(bot, false, 6)
      let answered = false
      void bot.waitForTicks(6 + 6).then(() => { answered = true })
      await withTimeout(digInSight(bot, bot.blockAt(pos)), 8000, 'the dig never ended')
      assert.equal(digs(), 1)
      assert.equal(bot.blockAt(pos).name, 'air')
      assert.ok(answered, 'resolved before the server answered')
    } finally {
      r.stopPassivePhysics()
    }
  })

  test(`${version}: answer false leaves the refusal to the caller (BreakHandler.staysGone): resolved on the client's break`, async () => {
    const { rig: r, bot, pos } = rig(version)
    try {
      lateAnswers(bot, true, 6)
      await withTimeout(digInSight(bot, bot.blockAt(pos), { answer: false }), 8000, 'the dig never ended')
      assert.equal(bot.blockAt(pos).name, 'air')
    } finally {
      r.stopPassivePhysics()
    }
  })

  test(`${version}: with no predictions to tell (a mineflayer without _isBlockPredicted) a block back within the settle's ticks is a refused dig`, async () => {
    const { rig: r, bot, pos } = rig(version)
    try {
      lateAnswers(bot, true, 1, false)
      await assert.rejects(withTimeout(digInSight(bot, bot.blockAt(pos)), 8000, 'the dig never ended'), DigRefusedError)
      assert.equal(bot.blockAt(pos).name, 'oak_leaves')
    } finally {
      r.stopPassivePhysics()
    }
  })
}
