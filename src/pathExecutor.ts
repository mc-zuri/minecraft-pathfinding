/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/restrict-template-expressions, no-unmodified-loop-condition, @typescript-eslint/no-throw-literal, @typescript-eslint/strict-boolean-expressions */
import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Path } from './mineflayer-specific/algs'
import * as goals from './mineflayer-specific/goals'
import { Move } from './mineflayer-specific/move'
import { AbortError, CancelError, ManualResetError, ResetError } from './mineflayer-specific/exceptions'
import type {
  BuildableMoveProvider,
  ExecutorMap,
  MovementExecutor
} from './mineflayer-specific/movements'
import type { OptimizationMap } from './mineflayer-specific/post'
import { Optimizer } from './mineflayer-specific/post'
import { World } from './mineflayer-specific/world/worldInterface'
import type { ResetReason } from './types'
import { ThePathfinder } from './ThePathfinder'
import { getScaffoldBudget, getScaffoldCount, printBotControls } from './utils'
import { moveKey } from './mineflayer-specific/movements/movementProvider'
import { describeMove } from './diagnostics/pathState'

const debug = require('debug')
const log = debug('minecraft-pathfinding:PathExecutor')

const EMPTY_VEC = new Vec3(0, 0, 0)
let warnedNonNodeSyncWait = false

export interface ExecutionMappings {
  movements: ExecutorMap
  optimizers: OptimizationMap
}

export interface PathfinderExecutionHost {
  getBot: () => Bot
  getWorld: () => World
  getActiveMappings: () => ExecutionMappings
  cleanupBot: () => Promise<void>
  getPathFromToRaw: (startPos: Vec3, startVel: Vec3, goal: goals.Goal) => Promise<Path | null>
}

type RunnerStage = 'idle' | 'align' | 'optimize' | 'init' | 'perform' | 'arrive'

/**
 * Ticks a move may hold the bot within NO_PROGRESS_DIST of one spot, with no dig or place under way, before it fails
 * (a CancelError: goto searches again, round it)
 */
export const NO_PROGRESS_TICKS = 60
export const NO_PROGRESS_DIST = 0.25

/** a move's ticks (no dig or place under way) before it fails: this many times its cost, and at least MIN_MOVE_TICKS */
export const MOVE_TICKS_FACTOR = 5
export const MIN_MOVE_TICKS = 100

/** physics ticks one movement tick may go on over (runSync) before the walk fails */
export const MAX_TICK_IN_FLIGHT = 100

/** horizontal speed (blocks a tick) under which a bot that let go of the keys in its goal counts as stopped */
const ARRIVE_STOP_SPEED = 0.03

/** ticks the bot may take to walk the rest of the way onto the path's last block */
const MAX_ARRIVE_TICKS = 40

function isNodeRuntime (): boolean {
  return typeof process !== 'undefined' && process.versions?.bun == null
}

let atomicsWaitAllowed: boolean | undefined

/**
 * Whether this thread may block in Atomics.wait: Node's main thread and workers may, a browser's main thread may not
 * (it throws), and without a SharedArrayBuffer (a page that isn't cross-origin isolated) there's nothing to wait on.
 * A wait on a value the array doesn't hold returns 'not-equal' at once where it's allowed.
 */
export function canAtomicsWait (): boolean {
  if (atomicsWaitAllowed != null) return atomicsWaitAllowed
  try {
    atomicsWaitAllowed = typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function' &&
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 1, 0) === 'not-equal'
  } catch {
    atomicsWaitAllowed = false
  }
  return atomicsWaitAllowed
}

/** forgets what canAtomicsWait found (tests) */
export function resetAtomicsWaitCheck (): void {
  atomicsWaitAllowed = undefined
}

export class PathExecutor {
  private currentExecutionId = 0
  private currentIndex = 0
  private currentPath?: Move[]
  private currentMove?: Move
  private currentExecutor?: MovementExecutor
  private resetReason?: ResetReason

  public constructor (private readonly bot: Bot, private readonly host: ThePathfinder) { }

  public bumpExecutionId (): number {
    this.currentExecutionId++
    return this.currentExecutionId
  }

  public getCurrentExecutionId (): number {
    return this.currentExecutionId
  }

  public getCurrentIndex (): number {
    return this.currentIndex
  }

  public setCurrentIndex (index: number): void {
    this.currentIndex = index
  }

  public getCurrentPath (): Move[] | undefined {
    return this.currentPath
  }

  public setCurrentPath (path?: Move[]): void {
    this.currentPath = path
  }

  public getCurrentMove (): Move | undefined {
    return this.currentMove
  }

  public setCurrentMove (move?: Move): void {
    this.currentMove = move
  }

  public getCurrentExecutor (): MovementExecutor | undefined {
    return this.currentExecutor
  }

  public setCurrentExecutor (executor?: MovementExecutor): void {
    this.currentExecutor = executor
  }

  /** what the last move that failed (CancelError) failed with */
  public lastMoveError?: string

  public getResetReason (): ResetReason | undefined {
    return this.resetReason
  }

  public setResetReason (reason?: ResetReason): void {
    this.resetReason = reason
  }

  public clearResetReason (): void {
    delete this.resetReason
  }

  private async timeAsync<T>(label: string, task: () => T | Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      return await Promise.resolve().then(task)
    } finally {
      const duration = performance.now() - start
      log(`${label} took ${duration.toFixed(2)}ms.`)
      log(`pos: ${this.bot.entity.position}`)
      printBotControls(this.bot, log)
    }
  }

  /**
   * Runs what a movement tick queued (its microtasks: the awaits of a tick that needs nothing else) in the physics tick
   * it started in, and waits on for it up to the pathfinder's moveTickBudgetMs. Whether it's done: a tick that waits on
   * more, a packet (a dig's or a block's) or a later tick (an abort waiting for the bot to land), goes on over the
   * ticks after, the bot keeping its controls, instead of failing the walk after 40 ms of wall clock (on a loaded
   * machine, and under a lockstep server whose tick waits on the client's). A wait here holds the event loop, which no
   * packet or timer gets through, so the default budget is 0; where the thread can't block (a browser's main thread,
   * canAtomicsWait) the budget is 0 whatever it's set to.
   */
  private runSync (state: { done: boolean }): boolean {
    if (state.done) return true
    const tickCallback = (process as NodeJS.Process & { _tickCallback?: () => void })._tickCallback
    tickCallback?.call(process)
    const budget = this.host.pathfinderSettings.moveTickBudgetMs ?? 0
    if (state.done || !(budget > 0) || !canAtomicsWait()) return state.done

    const waitArray = new Int32Array(new SharedArrayBuffer(4))
    const start = performance.now()
    while (!state.done && performance.now() - start < budget) {
      Atomics.wait(waitArray, 0, 0, 1)
      tickCallback?.call(process)
    }
    return state.done
  }

  /** the blocks the path places from its move at `index` on that the world doesn't have yet */
  private placesLeft (localPath: Move[], index: number): number {
    let n = 0
    for (let i = index; i < localPath.length; i++) {
      for (const place of localPath[i].toPlace) if (place.needToPerform(this.bot)) n++
    }
    return n
  }

  private findNextCurrentIdx (move: Move, localPath: Move[], currentIndex: number, adding?: boolean | number): number {
    const endIdx = localPath.findIndex(
      (m, i) => i >= currentIndex && m.exitPos.distanceTo(move.exitPos) < 0.1
    )

    if (typeof adding === 'number') {
      if (Number.isFinite(adding) && adding > 0) currentIndex += adding
    } else {
      currentIndex = endIdx !== -1 ? endIdx + 1 : currentIndex + 1
    }

    return currentIndex
  }

  public async perform (path: Path, goal: goals.Goal, entry = 0): Promise<void> {
    const MAX_RECOVERY_DEPTH = 0

    if (entry > MAX_RECOVERY_DEPTH) {
      throw new Error('Too many failures, exiting performing.')
    }

    const bot = this.bot
    const myExecutionId = this.bumpExecutionId()
    const localPath = path.path
    let currentIndex = 0

    this.setCurrentIndex(currentIndex)
    this.setCurrentPath(localPath)

    // the bot already stands where the goal holds: the search ends at its start, with no move to make
    if (localPath.length === 0 && path.status === 'success') return

    const { movements, optimizers } = this.host.getActiveMappings()

    let lastPathLength = -1
    let optSequence: Move[] = []
    let runnerStage: RunnerStage = 'idle'
    let pendingOptimize: Promise<void> | undefined
    let pendingInit: Promise<void> | undefined
    let tickCount = 0
    let arriveTicks = 0
    // where the bot was when the current move last got it anywhere, and the ticks since
    let progressPos = bot.entity.position.clone()
    let stillTicks = 0
    // the ticks the current move has run with no dig or place under way
    let moveTicks = 0
    // the edge guard's catches the current move has seen (EdgeGuard.catches)
    let guardCatches = 0
    // A move that holds the bot in one place (a jump it never lines up for, a corner it presses into) fails after
    // NO_PROGRESS_TICKS, so that goto searches again without it; a dig or a place under way is progress.
    const checkProgress = (executor: MovementExecutor, move: Move): void => {
      const pos = bot.entity.position
      const interacting = executor.cI != null || (bot as any).targetDigBlock != null
      // A move the edge guard held at a ledge last tick (its keys would have taken the bot off a drop deeper than it
      // may fall, with no move planning it) fails: its executor ran the bot wrong (a run on past its end, a line
      // across a ledge, a jump short), and goto searches again from the edge the bot is held at. A bridge's place or
      // a dig under way is waited on, the bot held.
      const guard = this.host.edgeGuard
      if (guard.catches !== guardCatches) {
        guardCatches = guard.catches
        const fall = guard.lastCatch?.fall
        if (!interacting && fall != null) {
          const depth = Number.isFinite(fall.depth) ? `a ${fall.depth.toFixed(1)}-block drop` : 'the void'
          throw new CancelError(`edge guard: the bot's keys would have taken it off ${depth}${fall.lava ? ' into lava' : ''} at ${fall.from.toString()} (${fall.allowed} allowed)`)
        }
      }
      // a move that goes on and on (a jump it backs up for and walks up to again and again) fails too, after
      // MOVE_TICKS_FACTOR times its cost in ticks
      if (!interacting && ++moveTicks > Math.max(MIN_MOVE_TICKS, MOVE_TICKS_FACTOR * move.cost)) {
        throw new CancelError(`${move.moveType.constructor.name} took over ${moveTicks - 1} ticks`)
      }
      if (pos.distanceTo(progressPos) > NO_PROGRESS_DIST || interacting) {
        progressPos = pos.clone()
        stillTicks = 0
        return
      }
      if (++stillTicks > NO_PROGRESS_TICKS) {
        throw new CancelError(`no progress in ${NO_PROGRESS_TICKS} ticks at ${pos.toString()}`)
      }
    }
    let settled = false
    let recoveryInFlight = false

    let resolveCompletion!: () => void
    let rejectCompletion!: (err: unknown) => void

    let nonNodeDrainInFlight = false

    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })

    const executorSafeReset = (executor?: MovementExecutor): void => {
      executor?.reset()
    }

    const finish = async (): Promise<void> => {
      if (settled) return
      settled = true
      bot.off('physicsTickBegin', moveListener)
      if (this.getCurrentExecutionId() === myExecutionId) {
        await this.timeAsync('finish cleanup', async () => await this.host.cleanupBot())
      }
      resolveCompletion()
    }

    const fail = async (err: unknown): Promise<void> => {
      if (settled) return
      settled = true
      bot.off('physicsTickBegin', moveListener)
      // an abort waiting on the executor (interrupt: MovementExecutor.abort) is let go
      executorSafeReset(this.getCurrentExecutor())
      rejectCompletion(err)
    }

    // A move that fails (CancelError: a jump that missed, a fall, a bot too low) ends the walk with a reset: goto
    // searches again from where the bot is (baritone's MovementStatus.UNREACHABLE, a new path calculated). The
    // recovery that did instead threw at once ('Too many failures', MAX_RECOVERY_DEPTH 0) and failed the goto.
    const moveFailed = (err: unknown): void => {
      log(`move failed, searching again: ${String(err)}`)
      // the next search goes round it
      const failed = localPath[currentIndex]
      if (failed != null) this.host.failedMoves.add(moveKey(failed))
      this.lastMoveError = err instanceof Error ? err.message : String(err)
      this.setResetReason('moveFailed')
      // (the stuck report's: the move, where the bot was, and why)
      const info = { move: failed != null ? describeMove(failed) : null, error: this.lastMoveError, pos: bot.entity.position.clone() }
      this.host.diagnostics.recordEvent('move_failed', { move: info.move, error: info.error, pos: [info.pos.x, info.pos.y, info.pos.z] })
      bot.emit('pathfinderMoveFailed', info)
    }

    const scheduleRecovery = (rawMove: Move): void => {
      if (recoveryInFlight) return
      recoveryInFlight = true

      void (async () => {
        try {
          await this.recovery(rawMove, path, goal, entry)
          await finish()
        } catch (recoveryErr) {
          await fail(recoveryErr)
        }
      })()
    }

    const handleExecutionError = async (err: unknown): Promise<void> => {
      log(`Error: ${err}`)

      if (err instanceof AbortError) {
        executorSafeReset(this.getCurrentExecutor())
        this.clearResetReason()
        await finish()
        return
      }

      if (err instanceof ManualResetError) {
        executorSafeReset(this.getCurrentExecutor())
        this.clearResetReason()
        await finish()
        return
      }

      if (err instanceof ResetError) {
        executorSafeReset(this.getCurrentExecutor())
        await finish()
        return
      }

      if (err instanceof CancelError) {
        executorSafeReset(this.getCurrentExecutor())

        if (err.message.includes('superseded')) {
          await finish()
          return
        }

        const rawMove = localPath[currentIndex]
        if (rawMove == null) {
          throw err
        }

        moveFailed(err)
        await finish()
        return
      }

      await fail(err)
      throw err
    }

    const beginOptimization = (): void => {
      if (pendingOptimize != null) return

      runnerStage = 'optimize'
      const optimizer = new Optimizer(bot, this.host.world, optimizers)
      optimizer.loadPath(localPath.slice(currentIndex))

      pendingOptimize = this.timeAsync('optimizer.compute', async () => await optimizer.compute()).then(
        (result) => {
          if (settled) return
          if (this.getCurrentExecutionId() !== myExecutionId) return

          optSequence = result
          lastPathLength = localPath.length
          pendingOptimize = undefined
          if (runnerStage === 'optimize') runnerStage = 'idle'
        },
        (err) => {
          pendingOptimize = undefined
          void fail(err)
        }
      )
    }

    const prepareNextMove = async (): Promise<boolean> => {
      while (currentIndex < localPath.length) {
        if (localPath.length !== lastPathLength) {
          beginOptimization()
          return false
        }

        if (pendingOptimize != null) return false

        const rawMove = localPath[currentIndex]
        const move = optSequence.find((m) => m.hash === rawMove.hash) ?? rawMove
        let executor: MovementExecutor | undefined

        if (rawMove !== move) {
          executor = move.optimizedExecutor
        }
        if (executor == null) {
          executor = movements.get(move.moveType.constructor as BuildableMoveProvider)
        }
        if (executor == null) {
          throw new Error('No executor for movement type ' + move.moveType.constructor.name)
        }

        this.setCurrentMove(move)
        this.setCurrentExecutor(executor)
        this.setCurrentIndex(currentIndex)
        this.setCurrentPath(localPath)

        // the move after this one as it will run (an optimizer's straight run of several), and the raw moves in it:
        // this one ends where that one can start from (MovementExecutor.readyForNext)
        const endIdx = localPath.findIndex((m, i) => i >= currentIndex && m.exitPos.distanceTo(move.exitPos) < 0.1)
        const nextRaw = endIdx !== -1 ? localPath[endIdx + 1] : undefined
        const nextRun = nextRaw != null ? (optSequence.find((m) => m.hash === nextRaw.hash) ?? nextRaw) : undefined
        const spanEnd = nextRun != null ? localPath.findIndex((m, i) => i > endIdx && m.exitPos.distanceTo(nextRun.exitPos) < 0.1) : -1
        executor.setFollowing(nextRun, nextRun != null ? localPath.slice(endIdx + 1, spanEnd === -1 ? endIdx + 2 : spanEnd + 1) : [])

        log(`[ExecID %d] Entering movement ${move.moveType.constructor.name}. Idx: ${this.getCurrentIndex()}, start: ${move.entryPos}, end: ${move.exitPos}`, myExecutionId)
        tickCount = 0
        progressPos = bot.entity.position.clone()
        stillTicks = 0
        moveTicks = 0
        // (a catch before the move, between paths, is no failure of its)
        guardCatches = this.host.edgeGuard.catches

        await this.timeAsync('prepare cleanup', async () => await this.host.cleanupBot())
        executor.loadMove(move)

        if (executor._isAlreadyCompleted(move, tickCount, goal, currentIndex, localPath)) {
          currentIndex = this.findNextCurrentIdx(move, localPath, currentIndex)
          this.setCurrentIndex(currentIndex)
          continue
        }

        // the blocks the rest of the path places, against the budget the inventory gives now (a search's): fewer
        // than it was planned with (a place tried again, blocks used or dropped on the way), and goto searches again
        // from here, before a bridge's move starts that the bot can't finish
        const placesLeft = this.placesLeft(localPath, currentIndex)
        if (placesLeft > 0 && placesLeft > getScaffoldBudget(bot, executor.settings)) {
          log('%d blocks left to place on the path, a budget of %d: searching again', placesLeft, getScaffoldBudget(bot, executor.settings))
          this.setResetReason('inventoryChanged')
          throw new ResetError('inventoryChanged', `${placesLeft} blocks to place, ${getScaffoldCount(bot, executor.settings)} held`)
        }

        runnerStage = 'align'
        return true
      }

      return false
    }

    const runMovementTick = async (): Promise<void> => {
      if (settled) return
      if (this.getCurrentExecutionId() !== myExecutionId) {
        await finish()
        return
      }

      try {
        while (!settled) {
          if (this.getCurrentExecutionId() !== myExecutionId) {
            await finish()
            return
          }

          if (runnerStage === 'idle') {
            const hasWork = await prepareNextMove()
            if (!hasWork) {
              if (pendingOptimize == null) {
                runnerStage = 'arrive'
                arriveTicks = 0
                continue
              }
              return
            }
            continue
          }

          if (runnerStage === 'arrive') {
            // A move ends once the bot is on its way over the last block (MovementExecutor.isComplete), so that the next
            // move takes over without a stop. After the last one nothing does: the bot walks the rest of the way, till
            // the goal holds at the block it stands in.
            const last = localPath[localPath.length - 1]
            const pos = bot.entity.position
            const node = { x: Math.floor(pos.x), y: Math.floor(pos.y + 1e-6), z: Math.floor(pos.z) }
            const left = last != null ? Math.hypot(last.exitPos.x - pos.x, last.exitPos.z - pos.z) : 0
            const speed = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)
            const there = goal.isEnd(node as Move)
            // in the goal, the keys let go and the bot stopped there (the ground's friction, a few ticks: the
            // momentum of a run in carried it off the goal's block after the walk ended on it)
            if (last == null || (there && (speed < ARRIVE_STOP_SPEED || !bot.entity.onGround)) || arriveTicks >= MAX_ARRIVE_TICKS || left > 2) {
              bot.clearControlStates()
              log(`execution ${myExecutionId} completed at ${bot.entity.position}`)
              await finish()
              return
            }
            arriveTicks++
            if (there) {
              bot.clearControlStates()
              return
            }
            if (bot.entity.onGround || (bot.entity as any).isInWater === true) {
              void bot.look(Math.atan2(-(last.exitPos.x - pos.x), -(last.exitPos.z - pos.z)), bot.entity.pitch, true)
              bot.setControlState('sprint', false)
              bot.setControlState('forward', left > 0.15)
            }
            return
          }

          if (runnerStage === 'optimize') {
            return
          }

          const move = this.getCurrentMove()
          const executor = this.getCurrentExecutor()

          if (move == null || executor == null) {
            throw new Error('Movement runner lost its current move or executor.')
          }

          if (runnerStage === 'align') {
            this.check()
            checkProgress(executor, move)

            const aligned = await this.timeAsync(
              `align ${move.moveType.constructor.name}`,
              async () => await executor.align(move, tickCount, goal)
            )
            tickCount++

            if (aligned) {
              runnerStage = 'init'
              pendingInit = this.timeAsync(
                `performInit ${move.moveType.constructor.name}`,
                async () => await executor._performInit(move, currentIndex, localPath)
              )
              pendingInit.then(
                () => {
                  if (settled) return
                  if (this.getCurrentExecutionId() !== myExecutionId) return
                  tickCount = 0
                  runnerStage = 'perform'
                  pendingInit = undefined
                },
                (err) => {
                  // (a start given up on already: its walk is over)
                  if (settled) return
                  pendingInit = undefined
                  void handleExecutionError(err).catch((handleErr) => {
                    void fail(handleErr)
                  })
                }
              )
              continue
            }

            return
          }

          if (runnerStage === 'init') {
            return
          }

          if (runnerStage === 'perform') {
            this.check()
            checkProgress(executor, move)

            const adding = await this.timeAsync(
              `performPerTick ${move.moveType.constructor.name}`,
              async () => await executor._performPerTick(move, tickCount, currentIndex, localPath)
            )
            tickCount++

            if (adding) {
              currentIndex = this.findNextCurrentIdx(move, localPath, currentIndex, adding)
              this.setCurrentIndex(currentIndex)
              runnerStage = 'idle'
              this.setCurrentMove(undefined)
              this.setCurrentExecutor(undefined)
              tickCount = 0
              continue
            }

            return
          }
        }
      } catch (err) {
        log(`Error: ${err}`)
        if (err instanceof AbortError) {
          executorSafeReset(this.getCurrentExecutor())
          this.clearResetReason()
          await finish()
          return
        }

        if (err instanceof ManualResetError) {
          executorSafeReset(this.getCurrentExecutor())
          this.clearResetReason()
          await finish()
          return
        }

        if (err instanceof ResetError) {
          executorSafeReset(this.getCurrentExecutor())
          await finish()
          return
        }

        if (err instanceof CancelError) {
          executorSafeReset(this.getCurrentExecutor())

          if (err.message.includes('superseded')) {
            await finish()
            return
          }

          const rawMove = localPath[currentIndex]
          if (rawMove == null) {
            throw err
          }

          moveFailed(err)
          await finish()
          return
        }

        await fail(err)
        throw err
      }
    }

    // the ticks the current move's start (performInit) has run
    let initTicks = 0

    // a movement tick still running from an earlier physics tick (runSync)
    let tickInFlight: { done: boolean, ticks: number } | undefined

    const moveListener = (): void => {
      if (settled || recoveryInFlight) return
      if (tickInFlight != null) {
        if (!this.runSync(tickInFlight)) {
          // a tick that never ends (an await nothing answers) fails the walk, in the game's ticks
          if (++tickInFlight.ticks > MAX_TICK_IN_FLIGHT) {
            void fail(new Error(`PathExecutor: a movement tick went on for ${MAX_TICK_IN_FLIGHT} ticks`))
          }
          return
        }
        tickInFlight = undefined
      }
      if (runnerStage === 'init' || pendingInit != null) {
        // a move's start (its digs and places before it sets off) that never ends fails the move, in the game's ticks
        const move = this.getCurrentMove()
        const limit = move != null ? Math.max(MIN_MOVE_TICKS, MOVE_TICKS_FACTOR * move.cost) : Infinity
        if (move != null && ++initTicks > limit) {
          initTicks = 0
          pendingInit = undefined
          void handleExecutionError(new CancelError(`${move.moveType.constructor.name} took over ${Math.ceil(limit)} ticks to start`)).catch((err) => {
            void fail(err)
          })
        }
        return
      }
      initTicks = 0
      if (runnerStage === 'optimize' || pendingOptimize != null) {
        return
      }

      try {
        if (!isNodeRuntime()) {
          if (!warnedNonNodeSyncWait) {
            warnedNonNodeSyncWait = true
            console.warn(' physicsTick sync draining is disabled on this runtime; running movement ticks asynchronously.')
          }
          if (nonNodeDrainInFlight) return
          nonNodeDrainInFlight = true
          void runMovementTick().catch((err) => {
            void fail(err)
          }).finally(() => {
            nonNodeDrainInFlight = false
          })
          return
        }

        const state = { done: false, ticks: 0 }
        runMovementTick().catch((err) => {
          void fail(err)
        }).finally(() => {
          state.done = true
        })
        if (!this.runSync(state)) {
          log('movement tick goes on over the next physics ticks')
          tickInFlight = state
        }
      } catch (err) {
        void fail(err)
      }
    }

    beginOptimization()

    bot.prependListener('physicsTickBegin', moveListener)
    // the movement check and record, while the path executes
    const releaseDiagnostics = this.host.diagnostics.acquire()

    try {
      await completion
    } finally {
      bot.off('physicsTickBegin', moveListener)
      releaseDiagnostics()
    }
  }

  public async recovery (move: Move, path: Path, goal: goals.Goal, entry = 0): Promise<void> {
    const bot = this.bot
    log(`recovery ${entry} for ${move.moveType.constructor.name}`)

    while (!bot.entity.onGround && !(bot.entity as any).isInWater) {
      await bot.waitForTicks(1)
    }

    bot.emit('enteredRecovery', entry)
    await this.timeAsync('recovery cleanup', async () => await this.host.cleanupBot())

    const ind = path.path.findIndex((m) => m.entryPos.distanceTo(move.entryPos) < 0.1)
    if (ind === -1) {
      log(' recovery failed: could not find move in path')
      return
    }

    let newGoal: goals.Goal
    const pos = bot.entity.position
    let bad = false

    let nextMove = [...path.path].sort((a, b) => a.entryPos.distanceTo(pos) - b.entryPos.distanceTo(pos))[0] as Move | undefined
    if (nextMove == null || path.path.indexOf(nextMove) < ind) {
      bad = true
    } else if (path.path.indexOf(nextMove) === ind) {
      nextMove = path.path[ind + 1]
    }

    const no = entry > 5 || bad
    if (no || nextMove == null) {
      newGoal = goal
    } else {
      newGoal = goals.GoalBlock.fromVec(nextMove.vec)
    }

    const path1 = await this.timeAsync(
      'recovery pathfinding',
      async () => await this.host.getPathFromToRaw(bot.entity.position, EMPTY_VEC, newGoal)
    )

    if (path1 === null) {
      log(' recovery pathfinding returned null')
      bot.emit('exitedRecovery', entry)
    } else if (no) {
      log(' executing full recovery path')
      bot.emit('exitedRecovery', entry)
      await this.perform(path1, goal, entry + 1)
    } else {
      log(' executing partial recovery path')
      await this.perform(path1, newGoal, entry + 1)

      // We only need to splice the unoptimized path directly!
      path.path.splice(0, ind + 1)

      log(' continuing original goal after partial recovery')
      bot.emit('exitedRecovery', entry)
      await this.perform(path, goal, 0)
    }
  }

  private check (): void {
    const resetReason = this.getResetReason()
    if (resetReason != null) {
      throw new ResetError(resetReason)
    }
  }
}
