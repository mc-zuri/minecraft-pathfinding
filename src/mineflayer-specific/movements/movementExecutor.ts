/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/member-delimiter-style, @typescript-eslint/strict-boolean-expressions, @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unused-vars */
import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Move } from '../move'
import * as goals from '../goals'
import { World } from '../world/worldInterface'
import { BreakHandler, InteractHandler, InteractOpts, PlaceHandler } from './interactionUtils'
import { AbortError, CancelError, ManualResetError, ResetError } from '../exceptions'
import { Movement, MovementOptions } from './movement'
import { AABB, AABBUtils, Task } from '@nxg-org/mineflayer-util-plugin'
import { BaseSimulator, BotcraftPhysics, Controller, ControlStateHandler, EPhysicsCtx, PlayerState, SimulationGoal } from '@nxg-org/mineflayer-physics-util'
import { botStrafeMovement, botSmartMovement } from './controls'
import { getUnderlyingBBs } from './movementUtils'
import { getNormalizedPos, interpolateStepPoints, posToYawPitchFromEye } from '../../utils'
import { IPhysics } from '@nxg-org/mineflayer-physics-util/dist/physics/engines'
import type { RayType } from '../../types'

const debug = require('debug')

const log = debug('minecraft-pathfinding:movementExecutor')

// temp typing
interface AbortOpts {
  reason?: ResetError | AbortError | ManualResetError
  timeout?: number
}

export interface CompleteOpts {
  ticks?: number
  entry?: boolean
  checkPlaces?: boolean
  checkBreaks?: boolean
}

export interface AlignmentBBInfo {
  pos: Vec3
  requireSupport: boolean
}

export interface InitAlignOpts {
  others?: AlignmentBBInfo[]
  customBB?: AABB
  enterExitInterp?: boolean
}

export interface SimOpts {
  ticks?: number, controls?: ControlStateHandler, ectx?: EPhysicsCtx<PlayerState>
}

export interface PostInitAlignOpts { handleBack?: boolean, lookAt?: Vec3, lookAtYaw?: Vec3, sprint?: boolean }

export abstract class MovementExecutor extends Movement {
  /**
   * Physics engine, baby.
   */
  protected sim: BaseSimulator<PlayerState>

  /**
   * Entity state of bot
   */
  protected simCtx: EPhysicsCtx<PlayerState>

  /** */
  protected engine: IPhysics

  /**
   * Return the current interaction.
   */
  public get cI (): InteractHandler | undefined {
    // if (this._cI === undefined) return undefined;
    // if (this._cI.allowExit) return undefined;
    return this._cI
  }

  /**
   * Whether or not this movement has been cancelled/aborted.
   */
  public aborted = false

  /**
   * Whether or not this movement is asking for a reset.
   */
  public resetReason?: AbortOpts['reason']

  private task: Task<void, void> = new Task()

  public constructor (bot: Bot, world: World, settings: Partial<MovementOptions> = {}) {
    super(bot, world, settings)
    this.engine = new BotcraftPhysics(bot.registry)
    this.sim = new BaseSimulator(this.engine)
    this.simCtx = EPhysicsCtx.FROM_BOT(this.engine, bot)
  }

  public reset (): void {
    // log('Resetting MovementExecutor')
    this.aborted = false
    delete this.interactionError
    delete this.resetReason
    this.task.finish()
    // the walk this executor ran is over (the move failed, its start took too long, goto ended): its digs and places
    // stop, and a start still under way (performInit's digs, one after another) goes no further. Left on, a
    // ForwardJump given up on after 204 ticks of its start dug on beside the next path's moves, which run on this same
    // executor: mineflayer ends a dig when another is asked for ('Digging aborted'), and the old dig's failure failed
    // the new move ('interaction failed') as its block broke.
    this.run++
    for (const interaction of this.inFlight) void interaction._abort(this.bot).catch(() => {})
    this.inFlight.clear()
    this.endedMove = this.currentMove
  }

  override loadMove (move: Move): void {
    super.loadMove(move)
    // (the same move walked again is under way again)
    if (move === this.endedMove) this.endedMove = undefined
  }

  /** the move of the walk that ended last (reset), until it is walked again: its interactions start no more */
  private endedMove?: Move

  /** the walk the executor's interactions belong to: one that ended (reset) has its interactions given up */
  private run = 0
  /** the interactions under way (performInteraction) */
  private readonly inFlight = new Set<InteractHandler>()

  protected getRemainingBreaks (): BreakHandler[] {
    if (!this.currentMove) return []
    return this.currentMove.toBreak.filter(b => b.needToPerform(this.bot))
  }

  protected getRemainingPlaces (): PlaceHandler[] {
    if (!this.currentMove) return []
    return this.currentMove.toPlace.filter(b => b.needToPerform(this.bot))
  }

  protected isTooLow (thisMove: Move) {
    const botY = this.bot.entity.position.y + 0.6 // allow step up

    const block = this.getBlockInfo(this.bot.entity.position, 0, 0, 0)

    if (botY < thisMove.exitPos.y && botY < thisMove.entryPos.y) {
      throw new CancelError(`y level: too low! ${botY}, ${thisMove.entryPos.y} ${thisMove.exitPos.y}`)
    }
  }

  /**
   * TODO: Implement.
   */
  public async abort (move: Move = this.currentMove, settings: AbortOpts = {}): Promise<void> {
    // if (this.aborted || this.resetReason != null) return

    const resetting = settings.reason
    log('Aborting movement. Reason:', resetting?.message ?? 'None')

    this.aborted = true
    this.resetReason = resetting

    await this.task.promise

    this.task = new Task()
  }

  /** ticks an aborted move waits for the bot to land (safeToCancel) before it fails */
  public static readonly ABORT_LAND_TICKS = 100

  private async holdUntilAborted (move: Move, task: Task<void>, timeoutTicks = MovementExecutor.ABORT_LAND_TICKS): Promise<void> {
    if (!this.aborted && this.resetReason == null) return

    log('holdUntilAborted: aborting process started')
    let start = performance.now()

    for (const breakTarget of move.toBreak) {
      await breakTarget._abort(this.bot)
    }

    log('aborted breaks in %d ms', performance.now() - start)
    start = performance.now()

    for (const place of move.toPlace) {
      await place._abort(this.bot)
    }

    log('aborted places in %d ms', performance.now() - start)
    start = performance.now()

    if (!this.safeToCancel(move)) {
      // TODO: handle bug (nextMove not included).
      // in the game's ticks, not a second of wall clock (a fall takes as many ticks however fast they run)
      await new Promise<void>((resolve, reject) => {
        let ticks = 0
        const listener = (): void => {
          if (this.safeToCancel(move)) {
            this.bot.off('physicsTick', listener)
            // task.finish()
            resolve()
          } else if (++ticks >= timeoutTicks) {
            this.bot.off('physicsTick', listener)
            reject(new Error('Movement failed to abort properly.'))
          }
        }
        this.bot.on('physicsTick', listener)
      })
    }

    log('aborted all in %d ms', performance.now() - start)

    if (this.resetReason != null) throw this.resetReason // new ResetError('Movement is resetting.')
    if (this.aborted) throw new AbortError('Movement aborted.')
  }

  /**
   * TODO: potentially buggy code. Check.
   */
  public async perform (thisMove: Move, currentIndex: number, path: Move[]): Promise<void> {
    log('Performing move at index %d', currentIndex)
    this.currentMove = thisMove
    if (this.resetReason != null) throw this.resetReason // new ResetError('Movement is resetting.')
    if (this.aborted) throw new AbortError('Movement aborted.')

    await this._performInit(thisMove, currentIndex, path)

    let result: boolean | number = false
    await new Promise<void>((resolve, reject) => {
      const listener = async (): Promise<void> => {
        if (this.aborted) {
          reject(new AbortError('Movement aborted.'))
        }
        if (this.resetReason != null) {
          reject(this.resetReason)
        }

        if (result === false) {
          result = await this._performPerTick(thisMove, tickCount, currentIndex, path)
        }

        if (result as boolean) {
          this.bot.off('physicsTick', listener)
          resolve()
        }
      }
      this.bot.on('physicsTick', listener)
    })

    let tickCount = 0

    while (result === false) {
      result = await this._performPerTick(thisMove, tickCount, currentIndex, path)
      tickCount++
    }
  }

  public async _performInit (thisMove: Move, currentIndex: number, path: Move[]): Promise<void> {
    await this.holdUntilAborted(thisMove, this.task)
    this.heldForNextTicks = 0
    delete this.interactionError
    return await this.performInit(thisMove, currentIndex, path)
  }

  public async _performPerTick (thisMove: Move, tickCount: number, currentIndex: number, path: Move[]): Promise<boolean | number> {
    await this.holdUntilAborted(thisMove, this.task)
    this.throwIfInteractionFailed()
    if (this.digging) {
      this.holdForDig()
      return false
    }
    const done = await this.performPerTick(thisMove, tickCount, currentIndex, path)
    if (done !== true) return done
    if (this.readyForNext(thisMove, currentIndex, path)) return true
    // over the move's block, but not yet where the next move can go from: on to the block's middle
    this.steerToExit(thisMove)
    return false
  }

  /**
   * Whether the move is over before it starts (isAlreadyCompleted), and the bot is where the one after it can start
   * from (see readyForNext).
   */
  public _isAlreadyCompleted (thisMove: Move, tickCount: number, goal: goals.Goal, currentIndex: number, path: Move[]): boolean {
    return this.isAlreadyCompleted(thisMove, tickCount, goal) && this.canStartNext(...this.nextOf(thisMove, currentIndex, path))
  }

  /**
   * The move that runs after this one, as the path's runner will run it (an optimizer's run of several raw moves: the
   * bot steers straight at its far end), and the raw moves it is made of. Set by the runner before the move starts.
   */
  private following?: { move: Move | undefined, span: Move[] }

  public setFollowing (move: Move | undefined, span: Move[] = move != null ? [move] : []): void {
    this.following = { move, span }
  }

  private nextOf (thisMove: Move, currentIndex: number, path: Move[]): [Move | undefined, Move[]] {
    // (with none known yet, the raw path: a partial path's tail may have come since)
    if (this.following?.move != null) return [this.following.move, this.following.span]
    const next = this.nextMoveOf(thisMove, currentIndex, path)
    return [next, next != null ? [next] : []]
  }

  /** ticks a complete move has been held for the next one to be able to start (readyForNext) */
  private heldForNextTicks = 0

  /** the most ticks a complete move is held for the next one to be able to start before it's let go anyway */
  public static readonly MAX_HELD_FOR_NEXT_TICKS = 20

  /**
   * A complete move (isComplete: the bot's box over its block, heading on) lets the next one take over only once the
   * bot stands where that one can start from (canStartNext), at the latest at the block's middle. Ended as soon as the
   * box touched the block, the move handed a turn over with the bot still beside the block, and the next one, steering
   * straight at its own block, pressed the bot into the corner of the wall it was turning round.
   */
  protected readyForNext (thisMove: Move, currentIndex: number, path: Move[]): boolean {
    const [next, span] = this.nextOf(thisMove, currentIndex, path)
    if (next == null) return true
    const pos = this.bot.entity.position
    if (Math.hypot(thisMove.exitPos.x - pos.x, thisMove.exitPos.z - pos.z) < MovementExecutor.EXIT_MIDDLE_DIST ||
      ++this.heldForNextTicks > MovementExecutor.MAX_HELD_FOR_NEXT_TICKS || this.canStartNext(next, span)) {
      this.heldForNextTicks = 0
      return true
    }
    return false
  }

  /** how near the middle of its block (horizontally) a move's end always lets the next one start */
  public static readonly EXIT_MIDDLE_DIST = 0.15

  /** the raw move after this one in the path (this one may be an optimizer's run of several: the move after its last) */
  protected nextMoveOf (thisMove: Move, currentIndex: number, path: Move[]): Move | undefined {
    for (let i = Math.max(0, currentIndex); i < path.length; i++) {
      if (path[i].exitPos.distanceTo(thisMove.exitPos) < 0.1) return path[i + 1]
    }
    return undefined
  }

  /**
   * Whether the bot can go from where it stands straight at the next move's block: the player's box, moved along that
   * line, runs into no block's collision shape (as Entity.collide would stop it), leaving out what it steps up onto
   * (maxUpStep, 0.6), the block columns of the raw moves the next one is made of (`span`: the path's own cells, a step
   * it jumps onto) and the blocks that move breaks. The next move is the one that runs: an optimizer's straight run of
   * several, steered at its far end, not the raw one block on.
   */
  public canStartNext (next: Move | undefined, span: Move[] = next != null ? [next] : []): boolean {
    if (next == null) return true
    const pos = this.bot.entity.position
    const target = next.exitPos
    const dx = target.x - pos.x
    const dz = target.z - pos.z
    const len = Math.hypot(dx, dz)
    if (len < 1e-6) return true

    const hW = 0.3 - 1e-3
    const minY = pos.y + 0.6 // what the bot steps up onto doesn't stop it (LivingEntity's maxUpStep)
    const maxY = pos.y + 1.8 - 1e-3
    const skip = new Set([next, ...span].map((m) => `${Math.floor(m.exitPos.x)},${Math.floor(m.exitPos.z)}`))
    const broken = new Set(next.toBreak.map((b) => `${b.vec.x},${b.vec.y},${b.vec.z}`))
    const steps = Math.ceil(len / 0.1)
    const shapes = new Map<string, AABB[]>()
    const shapesAt = (x: number, y: number, z: number): AABB[] => {
      const key = `${x},${y},${z}`
      let bbs = shapes.get(key)
      if (bbs == null) {
        bbs = []
        const info = this.world.getBlockInfo(new Vec3(x, y, z))
        if (info.physical && !broken.has(key)) {
          bbs = (info.block != null ? info.getBBs() : [new AABB(x, y, z, x + 1, info.height, z + 1)])
            // a shape the bot's box is in already (a doorway, a ladder) doesn't stop it either
            .filter((bb) => bb.maxY > minY && bb.minY < maxY && !this.boxOverlaps(bb, pos.x, pos.z, hW))
        }
        shapes.set(key, bbs)
      }
      return bbs
    }
    for (let s = 1; s <= steps; s++) {
      const cx = pos.x + (dx * s) / steps
      const cz = pos.z + (dz * s) / steps
      for (let x = Math.floor(cx - hW); x <= Math.floor(cx + hW); x++) {
        for (let z = Math.floor(cz - hW); z <= Math.floor(cz + hW); z++) {
          if (skip.has(`${x},${z}`)) continue
          for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
            for (const bb of shapesAt(x, y, z)) {
              if (this.boxOverlaps(bb, cx, cz, hW)) return false
            }
          }
        }
      }
    }
    return true
  }

  private boxOverlaps (bb: AABB, cx: number, cz: number, hW: number): boolean {
    return bb.minX < cx + hW && bb.maxX > cx - hW && bb.minZ < cz + hW && bb.maxZ > cz - hW
  }

  /**
   * A dig of the move is under way, its block still there: the look is the dig's (digInSight aims the crosshair at a
   * point of the block in sight and stops the dig when the crosshair leaves it, as vanilla breaks only the block the
   * crosshair hits). The executor's steering turned the bot along its path at pitch 0 each tick (the optimizer's
   * diagonal, a block off the line), the dig stopped, and after 8 tries the move failed.
   */
  protected get digging (): boolean {
    const cI = this._cI
    return cI instanceof BreakHandler && cI.isPerforming && cI.needToPerform(this.bot)
  }

  /** while the dig is under way the bot stands to mine, as a player does, and its look is left to the dig */
  protected holdForDig (): void {
    for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump'] as const) this.bot.setControlState(key, false)
  }

  /** holds the bot on for the middle of the move's block, the way it walks there (no jump, no sprint) */
  protected steerToExit (thisMove: Move): void {
    const exit = thisMove.exitPos
    void this.lookAtPathPos(exit)
    this.bot.setControlState('sprint', false)
    this.bot.setControlState('jump', ((this.bot.entity as any).isInWater as boolean) && this.bot.entity.position.y < exit.y)
    botStrafeMovement(this.bot, exit, true)
    botSmartMovement(this.bot, exit, false)
  }

  public async _align (thisMove: Move, tickCount: number, goal: goals.Goal): Promise<boolean> {
    await this.holdUntilAborted(thisMove, this.task)
    return await this.align(thisMove, tickCount, goal)
  }

  /**
   * Runtime calculation.
   *
   * Perform initial setup upon movement start.
   * Can be sync or async.
   */
  abstract performInit (thisMove: Move, currentIndex: number, path: Move[]): void | Promise<void>

  /**
   * Runtime calculation.
   *
   * Perform modifications on bot per-tick.
   * Return whether or not bot has reached the goal.
   *
   */
  abstract performPerTick (
    thisMove: Move,
    tickCount: number,
    currentIndex: number,
    path: Move[]
  ): boolean | number | Promise<boolean | number>

  /**
   * Runtime calculation.
   *
   * Perform modifications on bot BEFORE attempting the move.
   * This can be used to align to the center of blocks, etc.
   * Align IS allowed to throw exceptions, it will revert to recovery.
   */
  align (thisMove: Move, tickCount?: number, goal?: goals.Goal, lookTarget?: Vec3): boolean | Promise<boolean> {
    const target = lookTarget ?? thisMove.entryPos
    if (lookTarget != null) void this.postInitAlignToPath(thisMove, { lookAt: target })
    else void this.postInitAlignToPath(thisMove)

    return this.isInitAligned(thisMove, target)
  }

  /**
   * Runtime calculation.
   *
   * Check whether or not the move is already currently completed. This is checked once, before alignment.
   */
  isAlreadyCompleted (thisMove: Move, tickCount: number, goal: goals.Goal): boolean {
    return this.isComplete(thisMove)
  }

  /**
   * Default implementation of isComplete.
   *
   * Checks whether or not the bot hitting the target block is unavoidable.
   *
   * Does so via velocity direction check (heading towards the block)
   * and bounding box check (touching OR slightly above block).
   */
  protected isComplete (startMove: Move, endMove: Move = startMove, opts: CompleteOpts = {}): boolean {
    if (this.cI !== undefined) {
      if (!this.cI.allowExit) return false
    }

    const checkP = opts.checkPlaces ?? true
    const checkB = opts.checkBreaks ?? true
    if (checkP && this.toPlaceLen() > 0) return false
    if (checkB && this.toBreakLen() > 0) return false

    const ticks = opts.ticks ?? 1

    const target = endMove.exitPos
    const offset = endMove.exitPos.minus(this.bot.entity.position)
    const dir = endMove.exitPos.minus(startMove.entryPos)

    // console.log(offset, dir)
    offset.translate(0, -offset.y, 0) // xz only
    dir.translate(0, -dir.y, 0) // xz only

    const xzVel = this.bot.entity.velocity.offset(0, -this.bot.entity.velocity.y, 0)
    const xzVelDir = xzVel.normalize()

    const dist = offset.norm()

    const ectx = EPhysicsCtx.FROM_BOT(this.bot.physicsUtil.engine, this.bot)
    const history = [ectx.position.clone()]
    for (let i = 0; i < ticks; i++) {
      ectx.state.control.set('jump', false) // we don't want to jump again.
      ectx.state.jumpQueued = false
      this.bot.physicsUtil.engine.simulate(ectx, this.world)
      history.push(ectx.position.clone())
    }

    const pos = ectx.state.pos.clone()

    // console.log(ectx.state.pos, ectx.state.isCollidedHorizontally, ectx.state.isCollidedVertically);

    const normPos = getNormalizedPos(this.bot, pos)

    // const pos = this.bot.entity.position
    const bb0 = AABBUtils.getPlayerAABB({ position: normPos, width: 0.599, height: 1.8 })
    // bb0.extend(0, ticks === 0 ? -0.251 : -0.1, 0);
    // bb0.expand(-0.0001, 0, -0.0001);

    let bb1bl
    let bbCheckCond = false
    let weGood = false

    const aboveWater =
      !ectx.state.isInWater &&
      !ectx.state.onGround &&
      this.bot.pathfinder.world.getBlockInfo(this.bot.entity.position.floored().translate(0, -0.6, 0)).liquid

    if (aboveWater) {
      bb1bl = this.bot.pathfinder.world.getBlockInfo(target.floored())
      bbCheckCond = bb1bl.walkthrough
      const bb1s = AABB.fromBlockPos(bb1bl.position)
      weGood = bb1s.collides(bb0) && bbCheckCond // && !(this.bot.entity as any).isCollidedHorizontally;
    } else if (ectx.state.isInWater) {
      bb1bl = this.bot.pathfinder.world.getBlockInfo(target.floored())
      bbCheckCond = bb1bl.liquid
      const bb1s = AABB.fromBlock(bb1bl.position)
      weGood = bb1s.collides(bb0) && bbCheckCond // && !(this.bot.entity as any).isCollidedHorizontally;
      // console.log('water check', bb1bl.block?.type, bb1s, bb0, bbCheckCond)
    } else {
      bb1bl = this.bot.pathfinder.world.getBlockInfo(target.floored().translate(0, -1, 0))
      bbCheckCond = bb1bl.physical
      const bb1s = bb1bl.getBBs()
      weGood = bb1s.some((b) => b.collides(bb0)) && bbCheckCond && pos.y >= bb1bl.height // && !(this.bot.entity as any).isCollidedHorizontally;
      // console.log(
      //   "land check",
      //   endMove.exitPos,
      //   bb1bl.block?.name,
      //   bb1s,
      //   bb0,
      //   bbCheckCond,
      //   bb1s.some((b) => b.collides(bb0)),
      //   pos.y >= bb1bl.height,
      //   history
      // );
    }
    // const bbOff = new Vec3(0, ectx.state.isInWater ? 0 : -1, 0)

    const headingThatWay = xzVelDir.dot(dir.normalize()) > -2
    const similarDirection = offset.normalize().dot(dir.normalize()) > 0.5

    if (weGood) {
      // console.log('we good checl', xzVelDir.normalize().dot(dir.normalize()), offset, headingThatWay,  similarDirection,  ectx.state.isCollidedHorizontally, ectx.state.isCollidedVertically)
      if (similarDirection && headingThatWay) return !ectx.state.isCollidedHorizontally // in air check.
      else if (dist < 0.2) return true
      else {
        return true
      }

      // console.log('finished!', this.bot.entity.position, endMove.exitPos, bbsVertTouching, similarDirection, headingThatWay, offset.y)
    }

    // console.log(
    //   "backup",
    //   this.bot.entity.position.xzDistanceTo(endMove.exitPos),
    //   this.bot.entity.position.y,
    //   endMove.exitPos.y,
    //   this.bot.entity.onGround,
    //   this.bot.entity.velocity.offset(0, -this.bot.entity.velocity.y, 0).norm()
    // );

    // default implementation of being at the center of the block.
    // Technically, this may be true when the bot overshoots, which is fine.
    return (
      this.bot.entity.position.xzDistanceTo(endMove.exitPos) < 0.2 &&
      this.bot.entity.position.y === endMove.exitPos.y &&
      this.bot.entity.onGround
    )
  }

  public isInitAligned (thisMove: Move, target: Vec3 = thisMove.entryPos, options: InitAlignOpts = {}): boolean {
    if (this.isComplete(thisMove)) return true

    const off0 = thisMove.exitPos.minus(this.bot.entity.position).normalize()
    const off1 = thisMove.exitPos.minus(target).normalize()

    if (this.bot.entity.position.y < thisMove.entryPos.y - 1) throw new CancelError('MovementExecutor: bot is too low.')

    log('isInitAligned: off0.dot(off1)=%d', off0.dot(off1))

    off0.translate(0, -off0.y, 0)
    off1.translate(0, -off1.y, 0)

    const similarDirection = off0.dot(off1) > 0.7

    let bb0 = options.customBB
    if (bb0 == null) {
      const normPos = getNormalizedPos(this.bot)
      bb0 = AABBUtils.getEntityAABBRaw({ position: normPos, width: 0.6, height: 1.8 })
    }

    const toCheck = options.others ?? []
    const entercheck = { pos: target.offset(0, -1, 0), requireSupport: true }
    const exitCheck = { pos: thisMove.exitPos.floored().translate(0, -1, 0), requireSupport: true }

    toCheck.push(entercheck)
    toCheck.push(exitCheck)

    let valid

    // default false.
    if (options.enterExitInterp) {
      valid = this.interpolatedBBCheck(bb0, thisMove.cachedVec.offset(0.5, 0, 0.5), thisMove.exitPos.floored().offset(0.5, 0, 0.5)) || this.boundingBoxCheck(bb0, ...toCheck)
    } else valid = this.boundingBoxCheck(bb0, ...toCheck)
    if (valid) {
      log('isInitAligned: yaw check passed. similarDirection=%s, dist=%d', similarDirection, this.bot.entity.position.xzDistanceTo(target))
      if (similarDirection) return true
      else {
        log('exit -> cur: %O, exit -> target: %O', off0, off1, off0.dot(off1))
        if (this.bot.entity.position.xzDistanceTo(target) < 0.3) return true
        if (this.boundingBoxCheck(bb0, exitCheck)) return true
      }
    }

    log('isInitAligned: We are not aligned. us: %O, target pos: %O', bb0, target)
    log('Extra info: opts: %O', options)
    return false
  }

  /**
   * Lazy code.
   */
  public safeToCancel (startMove: Move, endMove: Move = startMove): boolean {
    return this.bot.entity.onGround || ((this.bot.entity as any).isInWater as boolean)
  }

  protected getTooLowCheckY (pos: Vec3 = this.bot.entity.position): number {
    const supportBbs = getUnderlyingBBs(this.world, pos, 0.6)
    if (supportBbs.length === 0) {
      return pos.y + 0.6
    }

    const supportHeight = Math.max(...supportBbs.map((bb) => bb.maxY - bb.minY))
    const supportCorrection = supportHeight < 1 ? 1 - supportHeight : 0
    return pos.y + 0.6 + supportCorrection
  }

  protected tooLowCheck (thisMove: Move, pos: Vec3 = this.bot.entity.position): boolean {
    const botY = this.getTooLowCheckY(pos)
    return botY < thisMove.exitPos.y && botY < thisMove.entryPos.y
  }

  /**
   * Provide information about the current move.
   *
   * Return breaks first as they will not interfere with placements,
   * whereas placements will almost always interfere with breaks (LOS failure).
   */
  async interactNeeded (ticks = 1): Promise<PlaceHandler | BreakHandler | undefined> {
    const start = performance.now()
    for (const breakTarget of this.currentMove.toBreak) {
      if (breakTarget !== this._cI && !breakTarget.done) {
        if (!breakTarget.needToPerform(this.bot)) continue
        const res = await breakTarget.performInfo(this.bot, ticks)
        log(`[${start - performance.now()}ms] interactNeeded: break ticks %d (raycasts: %s)`, res.ticks, res.raycasts.length > 0)
        if (res.ticks < Infinity) return breakTarget
      }
    }

    for (const place of this.currentMove.toPlace) {
      if (place !== this._cI && !place.done) {
        if (!place.needToPerform(this.bot)) continue
        const res = await place.performInfo(this.bot, ticks)
        log(`[${start - performance.now()}ms] interactNeeded: place ticks %d (raycasts: %s)`, res.ticks, res.raycasts.length > 0)
        if (res.ticks < Infinity) return place
      }
    }
  }

  /**
   * Generalized function to perform an interaction.
   */
  async performInteraction (interaction: PlaceHandler | BreakHandler, opts: InteractOpts = {}): Promise<void> {
    const ended = this.endedMove
    if (ended != null && (ended.toBreak.includes(interaction as BreakHandler) || ended.toPlace.includes(interaction as PlaceHandler))) {
      throw new AbortError('the walk of the interaction ended')
    }
    const run = this.run
    this._cI = interaction
    interaction.loadMove(this)
    this.inFlight.add(interaction)
    try {
      if (interaction instanceof PlaceHandler) {
        await this.performPlace(interaction, opts)
      } else if (interaction instanceof BreakHandler) {
        await this.performBreak(interaction, opts)
      }
    } catch (err) {
      // an interaction of a walk that ended fails nothing now: the move it was for is over
      if (run !== this.run) throw new AbortError('the walk of the interaction ended')
      // the move fails with it on its next tick (most callers don't wait for the interaction)
      log('interaction failed: %s', (err as Error)?.message ?? String(err))
      this.interactionError = err
      throw err
    } finally {
      this.inFlight.delete(interaction)
      // a failed dig or place doesn't stay the current interaction: left set, the move neither tried it again nor
      // went on, and the bot stood there (a StraightDown over a block it never broke)
      if (this._cI === interaction) this._cI = undefined
    }
    // (the start that waits on it goes no further)
    if (run !== this.run) throw new AbortError('the walk of the interaction ended')
  }

  /** what the last interaction of the move failed with, until the move's next tick throws it */
  protected interactionError?: unknown

  /** a failed interaction fails the move (a CancelError: goto searches again, round it) */
  protected throwIfInteractionFailed (): void {
    const err = this.interactionError
    if (err === undefined) return
    delete this.interactionError
    throw new CancelError(`interaction failed: ${(err as Error)?.message ?? String(err)}`)
  }

  protected async performPlace (place: PlaceHandler, opts: InteractOpts = {}): Promise<void> {
    const item = place.getItem(this.bot)
    if (item == null) throw new CancelError('MovementExecutor: no item to place')
    log('performPlace: placing item %s', item.name)
    await place._perform(this.bot, item, opts)
    this._cI = undefined
  }

  protected async performBreak (breakTarget: BreakHandler, opts: InteractOpts = {}): Promise<void> {
    const block = breakTarget.getBlock(this.bot.pathfinder.world)
    if (block == null) throw new CancelError('MovementExecutor: no block to break')
    const item = breakTarget.getItem(this.bot, block)
    log('performBreak: breaking block %s', block.name)
    await breakTarget._perform(this.bot, item, opts)
    this._cI = undefined
  }

  /**
 * Utility function to have the bot look in the direction of the target,
 * but only on the xz plane (pitch is always 0).
 */
  public async lookAtPathPos (vec3: Vec3, force = this.settings.forceLook): Promise<void> {
    if (this.digging) return // (the dig's look)
    const pos = this.bot.entity.position
    const dx = vec3.x - pos.x
    const dz = vec3.z - pos.z
    const yaw = Math.atan2(-dx, -dz)

    if (this.isLookingAtYawRotation(yaw, 0.001)) return
    await this.bot.look(yaw, 0, force)
  }

  public async look (yaw: number, pitch: number, force = this.settings.forceLook): Promise<void> {
    if (this.digging) return // (the dig's look)
    if (this.isLookingAtRotation(yaw, pitch, 0.001)) return
    await this.bot.look(yaw, pitch, force)
  }

  public async lookAt (vec3: Vec3, force = this.settings.forceLook): Promise<void> {
    if (this.digging) return // (the dig's look)
    if (this.isLookingAt(vec3, 0.001)) return
    await this.bot.lookAt(vec3, force)
  }

  public isLookingAt (vec3: Vec3, limit = 0.01): boolean {
    if (!this.settings.careAboutLookAlignment) return true

    const bl = this.bot.blockAtCursor(256) as unknown as RayType | null
    if (bl == null) return false

    const eyePos = this.bot.entity.position.offset(0, 1.62, 0)
    return bl.intersect.minus(eyePos).normalize().dot(vec3.minus(eyePos).normalize()) > 1 - limit
  }

  public isLookingAtYaw (vec3: Vec3, limit = 0.01): boolean {
    if (!this.settings.careAboutLookAlignment) return true

    const eyePos = this.bot.entity.position.offset(0, 1.62, 0)
    const targetDir = vec3.minus(eyePos).offset(0, -(vec3.minus(eyePos).y), 0)

    if (targetDir.norm() < 1e-8) return true

    const yaw = Math.atan2(-targetDir.x, -targetDir.z)
    return this.isLookingAtYawRotation(yaw, limit)
  }

  public isLookingAtRotation (yaw: number, pitch: number, limit = 0.01): boolean {
    if (!this.settings.careAboutLookAlignment) return true

    const currentYaw = this.bot.entity.yaw
    const currentPitch = this.bot.entity.pitch

    const currentDir = new Vec3(
      -Math.sin(currentYaw) * Math.cos(currentPitch),
      -Math.sin(currentPitch),
      -Math.cos(currentYaw) * Math.cos(currentPitch)
    ).normalize()

    const targetDir = new Vec3(
      -Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    ).normalize()

    return currentDir.dot(targetDir) > 1 - limit
  }

  public isLookingAtYawRotation (yaw: number, limit = 0.01): boolean {
    if (!this.settings.careAboutLookAlignment) return true

    const currentYaw = this.bot.entity.yaw
    const currentDir = new Vec3(
      -Math.sin(currentYaw),
      0,
      -Math.cos(currentYaw)
    ).normalize()

    const targetDir = new Vec3(
      -Math.sin(yaw),
      0,
      -Math.cos(yaw)
    ).normalize()

    return currentDir.dot(targetDir) > 1 - limit
  }

  // Utils for handling collisions

  private boundingBoxCheck (orgBB: AABB, ...info: AlignmentBBInfo[]): boolean {
    let valid = false
    for (const { pos, requireSupport } of info) {
      const bInfo = this.getBlockInfoRaw(pos)
      const bbs = bInfo.getBBs()
      if (bbs.length === 0) bbs.push(AABB.fromBlock(bInfo.position))

      if (requireSupport && !(bInfo.physical || bInfo.liquid)) {
        continue
      }
      valid = valid || bbs.some((b) => b.collides(orgBB)) // should shortcut.
    }
    return valid
  }

  private interpolatedBBCheck (orgBB: AABB, start: Vec3, end: Vec3): boolean {
    for (const pos of interpolateStepPoints(start, end, 0.8)) {
      const bInfo = this.getBlockInfoRaw(pos)
      const bbs = bInfo.getBBs()

      if (bbs.length === 0) {
        bbs.push(AABB.fromBlock(bInfo.position))
      }

      if (bbs.some((b) => b.collides(orgBB))) {
        return true
      }
    }
    log('interpolatedBBCheck: no collision. orgBB %O, from %O to %O', orgBB, start, end)
    return false
  }

  // Sim functions.

  protected resetState (): PlayerState {
    this.simCtx.state.update(this.bot)
    return this.simCtx.state
  }

  protected simUntil (...args: Parameters<BaseSimulator<PlayerState>['simulateUntil']>): ReturnType<BaseSimulator<PlayerState>['simulateUntil']> {
    this.simCtx.state.update(this.bot)
    return this.sim.simulateUntil(...args)
  }

  protected simUntilGrounded (controller: Controller, maxTicks = 1000): PlayerState {
    this.simCtx.state.update(this.bot)
    return this.sim.simulateUntil(
      (state) => state.onGround,
      () => { },
      controller,
      this.simCtx,
      this.world,
      maxTicks
    )
  }

  protected simJump ({ goal, controller }: { goal?: SimulationGoal, controller?: Controller } = {}, maxTicks = 1000): PlayerState {
    this.simCtx.state.update(this.bot)
    goal = goal ?? ((state) => state.onGround)
    controller =
      controller ??
      ((state) => {
        state.control.set('jump', true)
      })
    return this.sim.simulateUntil(goal, () => { }, controller, this.simCtx, this.world, maxTicks)
  }

  protected async postInitAlignToPath (
    startMove: Move,
    opts?: PostInitAlignOpts
  ): Promise<void>
  protected async postInitAlignToPath (
    startMove: Move,
    endMove?: Move,
    opts?: PostInitAlignOpts
  ): Promise<void>
  protected async postInitAlignToPath (startMove: Move, endMove?: any, opts?: any): Promise<void> {
    if (endMove === undefined) {
      endMove = startMove
      opts = {}
    } else if (endMove instanceof Move) {
      opts = opts ?? {}
    } else {
      opts = endMove
      endMove = startMove
    }

    let target = opts.lookAt ?? opts.lookAtYaw ?? endMove.exitPos
    // log('postInitAlignToPath: target=%O, opts=%O', target, opts)

    if (opts.lookAtYaw != null && opts.lookAt == null) {
      target = target.offset(0, -target.y + this.bot.entity.position.y + this.bot.entity.height, 0)
    }

    const sprint = opts.sprint ?? true

    if (target !== endMove.exitPos) {
      await this.lookAt(target)
      if (!this.isLookingAt(target, 0.01)) return
    } else {
      await this.lookAtPathPos(target)

      const yawPitch = posToYawPitchFromEye(this.bot.entity.position, 1.62, target)
      if (!this.isLookingAtYaw(target, 0.01)) {
        log(`postInitAlignToPath: failed yaw check (offset=${yawPitch.yaw - this.bot.entity.yaw})`)
      }
    }

    botStrafeMovement(this.bot, endMove.exitPos, true)
    botSmartMovement(this.bot, endMove.exitPos, sprint)

    // const orgControl = this.bot.getControlState('sneak')
    // if (this.willFallOff(1)) {
    //   log(`postInitAlignToPath: we are about to fall off! sneaking...`)
    //   this.bot.setControlState('sneak', true);
    // } else {
    //   this.bot.setControlState('sneak', orgControl)
    // }
  }

  /**
   * @returns whether we fall off.
   */
  public simForward (options: SimOpts = {}): EPhysicsCtx<PlayerState> {
    const ectx = options.ectx ?? EPhysicsCtx.FROM_BOT(this.sim.ctx, this.bot)
    const ticks = options.ticks ?? 1

    for (let i = 0; i < ticks; i++) {
      if (options.controls != null) {
        ectx.state.control = options.controls
      }

      this.sim.ctx.simulate(ectx, this.bot.world)
    }

    return ectx
  }

  protected doWaterLogic (): boolean {
    if ((this.bot.entity as any).isInWater as boolean) return true

    // potentially false, if underwater + standing on ground.
    if (this.bot.entity.onGround) return false

    const bl = this.getBlockInfo(this.bot.entity.position, 0, -0.6, 0)
    return bl.liquid
  }
}
