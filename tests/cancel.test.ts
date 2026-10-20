import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { createPlugin, goals } from '../src'
import { createCacheWorld } from './setup'

function withTimeout<T> (promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise.finally(() => { if (timer != null) clearTimeout(timer) }),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
  ])
}

/** physics ticks till the promise settles (it rejects with the promise's error) */
async function ticksTill (bot: any, promise: Promise<unknown>, ms: number, message: string): Promise<number> {
  let ticks = 0
  const onTick = (): void => { ticks++ }
  bot.on('physicsTick', onTick)
  try {
    await withTimeout(promise, ms, message)
  } finally {
    bot.off('physicsTick', onTick)
  }
  return ticks
}

/** the bot's movement keys held now */
function heldKeys (bot: any): string[] {
  return ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].filter(k => bot.getControlState(k) === true)
}

/** resolves on the first physics tick the check holds */
async function tickWhere (bot: any, check: () => boolean, ms: number, message: string): Promise<void> {
  let onTick: () => void = () => {}
  await withTimeout(new Promise<void>((resolve) => {
    onTick = () => { if (check()) resolve() }
    bot.on('physicsTick', onTick)
  }), ms, message).finally(() => bot.off('physicsTick', onTick))
}

for (const partialPathProducer of [false, true]) {
  test(`a cancel while a move's start digs (a ForwardJump's head room, stone by hand) ends goto within a few ticks: the dig stopped, the keys let go (full-26.3-fresh-z: goto went on 100 ticks past the drowning reflex's cancel, 'left behind') (partialPathProducer: ${partialPathProducer})`, async () => {
    const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
    rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer, partialPathLength: 50 } } as any))
    const bot: any = rig.bot
    const world = bot.world
    try {
      // a 1-wide corridor along x at z 0, shut in bedrock: the one way on is a jump up a bedrock step at x 1 whose head
      // room (stone at (1, 66, 0)) is dug first, in the ForwardJump's start (performInit)
      for (let x = -2; x <= 5; x++) for (let z = -1; z <= 1; z++) for (let y = 64; y <= 68; y++) world.setBlock(new Vec3(x, y, z), 'bedrock')
      for (const y of [64, 65, 66]) world.setBlock(new Vec3(0, y, 0), 'air')
      world.setBlock(new Vec3(1, 66, 0), 'stone')
      for (let x = 2; x <= 3; x++) for (const y of [65, 66]) world.setBlock(new Vec3(x, y, 0), 'air')
      world.setBlock(new Vec3(1, 65, 0), 'air')
      bot.entity.position = new Vec3(0.5, 64, 0.5)

      const goto = bot.pathfinder.goto(new goals.GoalBlock(3, 65, 0))
      goto.catch(() => {})
      let digTicks = 0
      await tickWhere(bot, () => bot.targetDigBlock != null && ++digTicks >= 5, 20000, `no dig started (at ${bot.entity.position})`)
      assert.equal(bot.pathfinder.currentMove?.moveType?.constructor?.name, 'ForwardJump')
      void bot.pathfinder.cancel()
      const ticks = await ticksTill(bot, goto, 20000, 'goto went on after the cancel')
      assert.ok(ticks <= 5, `goto returned ${ticks} ticks after the cancel`)
      assert.equal(bot.pathfinder.isPathing, false)
      assert.equal(bot.targetDigBlock ?? null, null, 'a dig still under way')
      assert.deepEqual(heldKeys(bot), [])
      assert.equal(world.getBlock(new Vec3(1, 66, 0)).name, 'stone', 'the dig went on to the end')
    } finally {
      rig.stopPassivePhysics()
    }
  })
}

test('a cancel while goto searches (its search spread over many ticks) ends it, and the cancel\'s own promise resolves (it waited on the search\'s idle executor, never reset, for good)', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { searchTickBudgetMs: 1, searchTimeoutMs: -1 } } as any))
  const bot: any = rig.bot
  const world = bot.world
  try {
    // a goal shut in bedrock: the search goes on over the flat world round it
    for (let x = 29; x <= 31; x++) for (let y = 63; y <= 66; y++) for (let z = -1; z <= 1; z++) world.setBlock(new Vec3(x, y, z), 'bedrock')
    world.setBlock(new Vec3(30, 64, 0), 'air')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goto = bot.pathfinder.goto(new goals.GoalBlock(30, 64, 0))
    goto.catch(() => {})
    let searchTicks = 0
    await tickWhere(bot, () => bot.pathfinder.isPathing && bot.pathfinder.currentPath == null && ++searchTicks >= 3, 20000, 'no search under way')
    const ticks = await ticksTill(bot, Promise.all([bot.pathfinder.cancel(), goto]), 20000, 'the cancel (or goto) never returned')
    assert.ok(ticks <= 5, `${ticks} ticks`)
    assert.equal(bot.pathfinder.isPathing, false)
  } finally {
    rig.stopPassivePhysics()
  }
})

test('a cancel as the walk ends (its last move done, the bot onto the goal\'s block, no move running) ends goto there: the goal\'s own end (GoalMineBlock\'s dig) isn\'t run', async () => {
  const rig = createCacheWorld('1.20.4', 64, new Vec3(0, 64, 0)).rig
  rig.bot.loadPlugin(createPlugin({ pathfinderSettings: { partialPathProducer: false }, moveSettings: { canDig: false } } as any))
  const bot: any = rig.bot
  const world = bot.world
  try {
    world.setBlock(new Vec3(10, 64, 0), 'stone')
    bot.entity.position = new Vec3(0.5, 64, 0.5)
    const goal = goals.GoalMineBlock.fromBlock(bot.pathfinder.world, bot.blockAt(new Vec3(10, 64, 0)), 4, 1.62)
    let finished = 0
    goal.onFinish = async () => { finished++ }
    const goto = bot.pathfinder.goto(goal)
    goto.catch(() => {})
    await tickWhere(bot, () => {
      const path = bot.pathfinder.currentPath
      return bot.pathfinder.isPathing && path != null && path.length > 0 && bot.pathfinder.currentIndex >= path.length && bot.pathfinder.currentExecutor == null
    }, 20000, 'the walk never ended')
    void bot.pathfinder.cancel()
    const ticks = await ticksTill(bot, goto, 20000, 'goto went on after the cancel')
    assert.ok(ticks <= 5, `goto returned ${ticks} ticks after the cancel`)
    assert.equal(finished, 0, 'the goal\'s dig ran after the cancel')
    assert.deepEqual(heldKeys(bot), [])
  } finally {
    rig.stopPassivePhysics()
  }
})
