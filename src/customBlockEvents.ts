/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type, @typescript-eslint/restrict-template-expressions */
// blockEvents.ts
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import type { Vec3 } from 'vec3'
const createDebug = require('debug')

export type BlockUpdateListener = (oldBlock: Block | null, newBlock: Block | null) => void

export type BlockPositionString = `(${number}, ${number}, ${number})`
export type BlockPositionEventName = 'blockUpdate:(x, y, z)'
export type BlockEventName = 'blockUpdate' | BlockPositionEventName

type BlockEventListenerMap = {
  blockUpdate: BlockUpdateListener
} & {
  [K in BlockPositionEventName]: BlockUpdateListener
}

const debugIt = false
const listenerCounts = new WeakMap<Bot, Map<BlockEventName, number>>()

function debug (...args: any[]) {
  const log = createDebug('minecraft-pathfinding:block-events')
  if (debugIt) {
    log(...args)
  }
}

function getTrackedListenerCounts (bot: Bot): Map<BlockEventName, number> {
  let counts = listenerCounts.get(bot)
  if (counts == null) {
    counts = new Map<BlockEventName, number>()
    listenerCounts.set(bot, counts)
  }
  return counts
}

function changeTrackedListenerCount (bot: Bot, eventName: BlockEventName, delta: number): number {
  const counts = getTrackedListenerCounts(bot)
  const next = Math.max(0, (counts.get(eventName) ?? 0) + delta)
  counts.set(eventName, next)
  return next
}

export function getBlockEventListenerCount (bot: Bot, eventName: BlockEventName): number {
  return getTrackedListenerCounts(bot).get(eventName) ?? 0
}

export function getTotalBlockEventListenerCount (bot: Bot): number {
  let total = 0
  for (const count of getTrackedListenerCounts(bot).values()) {
    total += count
  }
  return total
}

export function toBlockPositionEventName (position: Vec3): BlockPositionEventName {
  return `blockUpdate:${position.toString()}` as BlockPositionEventName
}

export function onBlockEvent<K extends BlockEventName> (
  bot: Bot,
  eventName: K,
  listener: BlockEventListenerMap[K]
): void {
  debug('on %s', eventName)
  bot.on(eventName, listener as (...args: any[]) => void)
  const active = changeTrackedListenerCount(bot, eventName, 1)
  debug('active listeners %s=%d total=%d', eventName, active, getTotalBlockEventListenerCount(bot))
  if (eventName === 'blockUpdate' && active > 10) {
    console.warn(
      `[block-events] blockUpdate listeners active=${active} emitter=${bot.listenerCount(eventName)} total=${getTotalBlockEventListenerCount(bot)}`
    )
  }
}

export function onceBlockEvent<K extends BlockEventName> (
  bot: Bot,
  eventName: K,
  listener: BlockEventListenerMap[K]
): void {
  debug('once %s', eventName)
  const wrapped = ((...args: any[]) => {
    changeTrackedListenerCount(bot, eventName, -1)
    debug(
      'active listeners %s=%d total=%d',
      eventName,
      getBlockEventListenerCount(bot, eventName),
      getTotalBlockEventListenerCount(bot)
    )
    ;(listener as (...args: any[]) => void)(...args)
  }) as (...args: any[]) => void

  bot.once(eventName, wrapped)
  const active = changeTrackedListenerCount(bot, eventName, 1)
  debug('active listeners %s=%d total=%d', eventName, active, getTotalBlockEventListenerCount(bot))
}

export function offBlockEvent<K extends BlockEventName> (
  bot: Bot,
  eventName: K,
  listener: BlockEventListenerMap[K]
): void {
  debug('off %s', eventName)
  bot.off(eventName, listener as (...args: any[]) => void)
  const active = changeTrackedListenerCount(bot, eventName, -1)
  debug('active listeners %s=%d total=%d', eventName, active, getTotalBlockEventListenerCount(bot))
}

export function handleBlockEvent<K extends BlockEventName> (
  bot: Bot,
  eventName: K,
  listener: BlockEventListenerMap[K]
): () => void {
  onBlockEvent(bot, eventName, listener)
  return () => offBlockEvent(bot, eventName, listener)
}

export function handleBlockPositionEvent (
  bot: Bot,
  position: Vec3,
  listener: BlockUpdateListener
): () => void {
  return handleBlockEvent(bot, toBlockPositionEventName(position), listener)
}

export interface WaitForBlockEventOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export async function waitForBlockEvent<K extends BlockEventName> (
  bot: Bot,
  eventName: K,
  opts: WaitForBlockEventOptions = {}
): Promise<Parameters<BlockEventListenerMap[K]>> {
  const { timeoutMs = 5000, signal } = opts

  return await new Promise((resolve, reject) => {
    let finished = false
    let timeout: NodeJS.Timeout | undefined

    const cleanup = () => {
      if (timeout != null) clearTimeout(timeout)
      offBlockEvent(bot, eventName, listener)
      signal?.removeEventListener('abort', onAbort)
    }

    const succeed = (...args: Parameters<BlockEventListenerMap[K]>) => {
      if (finished) return
      finished = true
      cleanup()
      debug('resolved waitForBlockEvent %s', eventName)
      resolve(args)
    }

    const fail = (err: Error) => {
      if (finished) return
      finished = true
      cleanup()
      debug('rejected waitForBlockEvent %s: %s', eventName, err.message)
      reject(err)
    }

    const listener = ((...args: Parameters<BlockEventListenerMap[K]>) => {
      succeed(...args)
    }) as BlockEventListenerMap[K]

    const onAbort = () => {
      fail(new Error(`Aborted while waiting for ${eventName}`))
    }

    onBlockEvent(bot, eventName, listener)

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        fail(new Error(`Timed out waiting for ${eventName}`))
      }, timeoutMs)
    }

    if (signal != null) {
      if (signal.aborted) {
        fail(new Error(`Aborted while waiting for ${eventName}`))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

// A block settles after a count of the bot's ticks (physicsTick), not after a time: a block the bot digs or places
// is the client's prediction until the server's answer, which the server sends from its next tick
// (ServerGamePacketListenerImpl.handlePlayerAction / handleUseItemOn, then the block update and
// ClientboundBlockChangedAckPacket). Two client ticks cover that tick at 20 TPS, and under a lockstep server, which
// sends its tick's packets before the client's next tick, they do whatever the speed the ticks run at.
export const DEFAULT_SETTLE_TICKS = 2

export interface WaitForSettledBlockPredicateOptions {
  timeoutMs?: number
  /** the bot's ticks to wait at most (0 or unset: no limit), the way to bound a wait that depends on the game's time */
  timeoutTicks?: number
  settleTicks?: number
  signal?: AbortSignal
}

export interface WaitForSettledBlockUpdateOptions {
  timeoutMs?: number
  settleTicks?: number
  signal?: AbortSignal
}

export interface HandleSettledBlockEventOptions {
  settleTicks?: number
  /** unused: a position settles after the bot's ticks, however long they take */
  timeoutMs?: number
  signal?: AbortSignal
}

export type SettledBlockUpdateListener = (
  oldBlock: Block | null,
  newBlock: Block | null,
  settledBlock: Block | null
) => void | Promise<void>

interface PositionSettleController<TResult> {
  resolve: (value: TResult) => void
  reject: (err: Error) => void
  finishGuard: () => boolean
  position: Vec3
  eventName: BlockPositionEventName
  settleTicks: number
  bot: Bot
}

async function waitForPositionSettle<TResult> (
  bot: Bot,
  position: Vec3,
  opts: {
    timeoutMs?: number
    timeoutTicks?: number
    settleTicks?: number
    signal?: AbortSignal
    debugLabel: string
    createListener: (
      controller: PositionSettleController<TResult> & {
        armSettleTimer: (fn: () => void) => void
        cancelSettleTimer: () => void
      }
    ) => BlockUpdateListener
  }
): Promise<TResult> {
  const targetPosition = position.floored()
  const eventName = toBlockPositionEventName(targetPosition)
  const timeoutMs = opts.timeoutMs ?? 5000
  const settleTicks = opts.settleTicks ?? DEFAULT_SETTLE_TICKS
  const signal = opts.signal

  return await new Promise<TResult>((resolve, reject) => {
    let finished = false
    let timeoutTimer: NodeJS.Timeout | undefined
    let settleTickListener: (() => void) | undefined
    let timeoutTickListener: (() => void) | undefined

    const succeed = (value: TResult) => {
      if (finished) return
      finished = true
      cleanup()
      debug('resolved %s %s', opts.debugLabel, eventName)
      resolve(value)
    }

    const fail = (err: Error) => {
      if (finished) return
      finished = true
      cleanup()
      debug('rejected %s %s: %s', opts.debugLabel, eventName, err.message)
      reject(err)
    }

    // fn runs on the settleTicks-th physicsTick from now; arming again starts the count again
    const armSettleTimer = (fn: () => void) => {
      cancelSettleTimer()
      if (settleTicks <= 0) {
        if (!finished) fn()
        return
      }
      let ticks = 0
      const onTick = () => {
        if (++ticks < settleTicks) return
        cancelSettleTimer()
        if (finished) return
        fn()
      }
      settleTickListener = onTick
      bot.on('physicsTick', onTick)
    }

    const cancelSettleTimer = () => {
      if (settleTickListener != null) {
        bot.off('physicsTick', settleTickListener)
        settleTickListener = undefined
      }
    }

    const controller: PositionSettleController<TResult> & {
      armSettleTimer: (fn: () => void) => void
      cancelSettleTimer: () => void
    } = {
      resolve: succeed,
      reject: fail,
      finishGuard: () => finished,
      position,
      eventName,
      settleTicks,
      bot,
      armSettleTimer,
      cancelSettleTimer
    }

    const baseListener = opts.createListener(controller)

    const onUpdate: BlockUpdateListener = (oldBlock, newBlock) => {
      const updatedPosition = oldBlock?.position ?? newBlock?.position
      if (updatedPosition == null) return
      if (!updatedPosition.floored().equals(targetPosition)) return

      baseListener(oldBlock, newBlock)
    }

    const onAbort = () => {
      fail(new Error(`Aborted while waiting for ${eventName}`))
    }

    const cleanup = () => {
      if (timeoutTimer != null) clearTimeout(timeoutTimer)
      if (timeoutTickListener != null) bot.off('physicsTick', timeoutTickListener)
      cancelSettleTimer()
      offBlockEvent(bot, 'blockUpdate', onUpdate)
      signal?.removeEventListener('abort', onAbort)
    }

    onBlockEvent(bot, 'blockUpdate', onUpdate)

    // Seed the listener from the current world state so callers do not have to
    // wait for a second update before the settle timer can start.
    baseListener(null, bot.blockAt(targetPosition) ?? null)
    if (finished) return

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        fail(new Error(`Timed out waiting for ${opts.debugLabel} at ${position}`))
      }, timeoutMs)
    }

    const timeoutTicks = opts.timeoutTicks ?? 0
    if (timeoutTicks > 0) {
      let ticks = 0
      timeoutTickListener = () => {
        if (++ticks >= timeoutTicks) fail(new Error(`Timed out waiting ${timeoutTicks} ticks for ${opts.debugLabel} at ${position}`))
      }
      bot.on('physicsTick', timeoutTickListener)
    }

    if (signal != null) {
      if (signal.aborted) {
        fail(new Error(`Aborted while waiting for ${eventName}`))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
export async function waitForSettledBlockPredicate (
  bot: Bot,
  position: Vec3,
  predicate: (block: Block | null) => boolean,
  opts: WaitForSettledBlockPredicateOptions = {}
): Promise<Block | null> {
  return await waitForPositionSettle<Block | null>(bot, position, {
    timeoutMs: opts.timeoutMs,
    timeoutTicks: opts.timeoutTicks,
    settleTicks: opts.settleTicks ?? 10,
    signal: opts.signal,
    debugLabel: 'waitForSettledBlockPredicate',
    createListener: (controller) => {
      let candidate: Block | null = null

      return (_oldBlock, newBlock) => {
        const matches = predicate(newBlock)

        debug(
          'event %s new=%s matches=%s',
          controller.eventName,
          newBlock?.name ?? 'null',
          matches
        )

        if (matches) {
          candidate = newBlock
          ;controller.armSettleTimer(() => {
            debug(
              'settle check %s candidate=%s matches=%s',
              controller.eventName,
              candidate?.name ?? 'null',
              true
            )
            controller.resolve(candidate)
          })
        } else {
          candidate = null
          controller.cancelSettleTimer()
        }
      }
    }
  })
}

export async function waitForSettledBlockStateAtPosition (
  bot: Bot,
  position: Vec3,
  predicate: (block: Block | null) => boolean,
  opts: WaitForSettledBlockPredicateOptions = {}
): Promise<Block | null> {
  return await waitForPositionSettle<Block | null>(bot, position, {
    timeoutMs: opts.timeoutMs,
    timeoutTicks: opts.timeoutTicks,
    settleTicks: opts.settleTicks ?? DEFAULT_SETTLE_TICKS,
    signal: opts.signal,
    debugLabel: 'waitForSettledBlockStateAtPosition',
    createListener: (controller) => {
      return (_oldBlock, _newBlock) => {
        const current = controller.bot.blockAt(controller.position) ?? null
        const matches = predicate(current)

        debug(
          'event %s current=%s matches=%s',
          controller.eventName,
          current?.name ?? 'null',
          matches
        )

        if (matches) {
          ;controller.armSettleTimer(() => {
            const settled = controller.bot.blockAt(controller.position) ?? null
            const settledMatches = predicate(settled)

            debug(
              'settle check %s current=%s matches=%s',
              controller.eventName,
              settled?.name ?? 'null',
              settledMatches
            )

            if (settledMatches) {
              controller.resolve(settled)
            }
          })
        } else {
          controller.cancelSettleTimer()
        }
      }
    }
  })
}

export async function waitForSettledBlockUpdateAtPosition (
  bot: Bot,
  position: Vec3,
  opts: WaitForSettledBlockUpdateOptions = {}
): Promise<Block | null> {
  return await waitForPositionSettle<Block | null>(bot, position, {
    timeoutMs: opts.timeoutMs,
    settleTicks: opts.settleTicks ?? DEFAULT_SETTLE_TICKS,
    signal: opts.signal,
    debugLabel: 'waitForSettledBlockUpdateAtPosition',
    createListener: (controller) => {
      return () => {
        ;controller.armSettleTimer(() => {
          const current = controller.bot.blockAt(controller.position) ?? null
          debug(
            'settle check %s current=%s',
            controller.eventName,
            current?.name ?? 'null'
          )
          controller.resolve(current)
        })
      }
    }
  })
}

interface PendingSettle {
  oldBlock: Block | null
  newBlock: Block | null
  position: Vec3
  ticks: number
}

/**
 * Listens to global blockUpdate events, but only calls the listener after the
 * affected position has gone quiet for `settleTicks` of the bot's ticks.
 *
 * - One blockUpdate listener and, while any position waits, one physicsTick listener, whatever the number of
 *   positions: a wait of its own for every position updated (a multi_block_change, water flowing, an explosion) put
 *   a blockUpdate and a physicsTick listener on the bot for each, hundreds at once, every one of them called on every
 *   later update
 * - A later update at a waiting position starts its ticks again; the listener gets the first update's blocks
 * - Reads the final block from the world before invoking the listener
 */
export function handleSettledBlockEvent (
  bot: Bot,
  listener: SettledBlockUpdateListener,
  opts: HandleSettledBlockEventOptions = {}
): () => void {
  const settleTicks = opts.settleTicks ?? DEFAULT_SETTLE_TICKS
  const pending = new Map<string, PendingSettle>()
  let ticking = false
  let disposed = false

  const keyOf = (pos: Vec3): string => `${pos.x},${pos.y},${pos.z}`

  const settle = (entry: PendingSettle, key: string): void => {
    const settledBlock = bot.blockAt(entry.position) ?? null
    void (async () => await listener(entry.oldBlock, entry.newBlock, settledBlock))().catch((err) => {
      debug('settled block listener failed for %s: %s', key, err instanceof Error ? err.message : String(err))
    })
  }

  const onTick = (): void => {
    for (const [key, entry] of pending) {
      if (++entry.ticks < settleTicks) continue
      pending.delete(key)
      settle(entry, key)
    }
    if (pending.size === 0) stopTicking()
  }

  const stopTicking = (): void => {
    if (!ticking) return
    ticking = false
    bot.off('physicsTick', onTick)
  }

  const disposeUpdates = handleBlockEvent(bot, 'blockUpdate', (oldBlock, newBlock) => {
    if (disposed) return
    if (oldBlock == null && newBlock == null) return

    const position = oldBlock?.position ?? newBlock?.position
    if (position == null) return

    const key = keyOf(position)
    const waiting = pending.get(key)
    if (waiting != null) {
      waiting.ticks = 0
      return
    }

    const entry: PendingSettle = { oldBlock, newBlock, position: position.clone(), ticks: 0 }
    if (settleTicks <= 0) {
      settle(entry, key)
      return
    }
    pending.set(key, entry)
    if (!ticking) {
      ticking = true
      bot.on('physicsTick', onTick)
    }
  })

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    disposeUpdates()
    stopTicking()
    pending.clear()
    opts.signal?.removeEventListener('abort', dispose)
  }
  opts.signal?.addEventListener('abort', dispose, { once: true })

  return dispose
}
