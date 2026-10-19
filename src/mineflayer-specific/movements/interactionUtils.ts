/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-var-requires, @typescript-eslint/restrict-template-expressions, @typescript-eslint/strict-boolean-expressions */
import { Bot, BotEvents } from 'mineflayer'
import { blockReach, digInSight, useInSight } from '../crosshairDig'
import { Vec3 } from 'vec3'

import type { Item } from 'prismarine-item'
import { BlockInfo } from '../world/cacheWorld'
import { clearToFace, pastShapes, PassagePart } from '../world/passages'
import { BotcraftPhysics, EPhysicsCtx } from '@nxg-org/mineflayer-physics-util'
import { World } from '../world/worldInterface'
import { AABB, AABBUtils, BlockFace } from '@nxg-org/mineflayer-util-plugin'

import { CancelError } from '../exceptions'
import { MovementOptions } from './movement'
import { MovementExecutor } from './movementExecutor'
import { scaffoldItem } from './scaffolding'
import type { Block, RayType } from '../../types'
import { faceToVec, Task } from '../../utils'
import { DEFAULT_SETTLE_TICKS, handleBlockEvent, waitForSettledBlockPredicate, toBlockPositionEventName, waitForSettledBlockStateAtPosition } from '../../customBlockEvents'

const debug = require('debug')

/** ticks a dig's promise gets to answer once its block is gone */
const DIG_ANSWER_TICKS = 20
const logBase = debug('minecraft-pathfinding:InteractHandler')
const logPlace = debug('minecraft-pathfinding:PlaceHandler')
const logBreak = debug('minecraft-pathfinding:BreakHandler')

export type InteractType = 'water' | 'solid' | 'replaceable'

interface InteractionPerformInfo {
  ticks: number
  tickAllowance: number
  shiftTick: number
  raycasts: RayType[]
}

export interface InteractOpts {
  info?: InteractionPerformInfo
  returnToStart?: boolean
  returnToPos?: Vec3
  predictBlock?: boolean
  noAwait?: boolean
}

/**
 * TODO: Predict time of rotation for looking.
 *
 * Allow looking sooner than the actual block placement.
 */
export abstract class InteractHandler {
  protected performing = false
  public cancelled = false

  protected _equipping = false
  protected _done = false
  protected _internalLock = true
  protected task?: Task<void, Error>

  public readonly blockInfo: BlockInfo

  protected readonly move!: MovementExecutor

  protected get settings (): MovementOptions {
    return this.move.settings
  }

  public get vec (): Vec3 {
    return new Vec3(this.x, this.y, this.z)
  }

  public get bb (): AABB {
    return AABB.fromBlock(this.vec)
  }

  public get equipping (): boolean {
    return this._equipping
  }

  constructor (
    public readonly x: number,
    public readonly y: number,
    public readonly z: number,
    public readonly type: InteractType,
    public readonly offhand = false
  ) {
    this.blockInfo = this.toBlockInfo()
  }

  public get isPerforming (): boolean {
    return this.performing
  }

  public get done (): boolean {
    return this._done
  }

  public get allowExit (): boolean {
    return !this._internalLock
  }

  public loadMove (move: MovementExecutor): void {
    (this as any).move = move
  }

  abstract needToPerform (bot: Bot): boolean

  abstract getItem (bot: Bot, block?: Block): Item | null
  abstract perform (bot: Bot, item: Item | null, opts?: InteractOpts): Promise<void>
  abstract performInfo (bot: Bot, ticks?: number): Promise<InteractionPerformInfo>
  abstract toBlockInfo (): BlockInfo

  abstract abort (bot: Bot): Promise<void>

  public async _abort (bot: Bot): Promise<void> {
    if (this.performing && !this.cancelled) {
      logBase(`Aborting interaction at ${this.vec}`)
      await this.abort(bot)
      this.performing = false
      this.cancelled = true
    }
  }

  public async _perform (bot: Bot, item: Item | null, opts: InteractOpts = {}): Promise<void> {
    if (this.performing) {
      logBase(`Error: Already performing interaction at ${this.vec}`)
      throw new Error('Already performing')
    }

    logBase(`Starting interaction at ${this.vec} (Type: ${this.type}, Offhand: ${this.offhand})`)
    this.performing = true
    this._internalLock = true
    this.task = new Task()

    const ret = await this.perform(bot, item, opts).catch((err) => {
      logBase(`Interaction failed at ${this.vec}: %O`, err)
      this._internalLock = false
      this.performing = false
      // an interaction the move called off (its task canceled) just ends; one that failed (a dig the server refused,
      // a place with nothing to place against) fails the move: `canceled != null` held for a task that wasn't
      // canceled (false), and the failure passed for a success, the block counted as broken, the bot walking into it
      if ((this.task as any)?.canceled === true) {
        this._done = true
        return
      }
      throw new CancelError(`Failed to perform ${this.constructor.name}`, err)
    })

    logBase(`Successfully completed interaction at ${this.vec}`)
    this._internalLock = false
    this._done = true
    this.performing = false
    return ret
  }

  getCurrentItem (bot: Bot): Item | null {
    if (this.offhand) return bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
    return bot.inventory.slots[bot.getEquipmentDestSlot('hand')]
  }

  async equipItem (bot: Bot, item: Item | null): Promise<void> {
    if (this._equipping) return // already equipping item, ignore silently.
    this._equipping = true
    if (item === null) {
      logBase(`Unequipping ${this.offhand ? 'off-hand' : 'hand'}`)
      await bot.unequip(this.offhand ? 'off-hand' : 'hand')
    } else if (this.offhand) {
      logBase(`Equipping ${item.name} to off-hand`)
      await bot.equip(item, 'off-hand')
    } else {
      logBase(`Equipping ${item.name} to hand`)
      await bot.equip(item, 'hand')
    }
    bot.updateHeldItem()
    // await bot.waitForTicks(2)
    this._equipping = false
  }

  async allowExternalInfluence (bot: Bot, ticks = 1, sneak = false): Promise<boolean> {
    if (!this.performing) return true
    if (!this._internalLock) return true

    const res = await this.performInfo(bot, ticks)
    if (res.ticks < Infinity) return true

    const ectx = new BotcraftPhysics(bot.registry)
    const state = EPhysicsCtx.FROM_BOT(ectx, bot)

    const flag0 = bot.entity.onGround
    for (let i = 0; i < ticks; i++) {
      ectx.simulate(state, bot.pathfinder.world as any)
    }

    if (flag0) if (state.position.y < bot.entity.position.y) return false

    if (state.state.pos.y < bot.entity.position.y) return false
    return this.bb.distanceToVec(state.state.pos) < PlaceHandler.reach
  }
}

export class PlaceHandler extends InteractHandler {
  static reach = 4
  private _placeTask?: Promise<void>

  static fromVec (vec: Vec3, type: InteractType, offhand = false): PlaceHandler {
    return new PlaceHandler(vec.x, vec.y, vec.z, type, offhand)
  }

  static identTypeFromItem (item: Item): InteractType {
    if (item.name.includes('water')) return 'water'
    return 'solid'
  }

  toBlockInfo (): BlockInfo {
    switch (this.type) {
      case 'solid':
        return BlockInfo.SOLID(this.vec)
      case 'water':
        return BlockInfo.WATER(this.vec)
      case 'replaceable':
        return BlockInfo.REPLACEABLE(this.vec)
      default:
        throw new Error('Invalid type')
    }
  }

  getItem (bot: Bot): Item | null {
    switch (this.type) {
      case 'water': {
        return bot.inventory.items().find((item) => item.name === 'water_bucket') ?? null
      }
      case 'solid': {
        // the cheapest of the scaffolding the inventory holds (MovementOptions.scaffoldingBlocks)
        return scaffoldItem(bot, this.move?.settings.scaffoldingBlocks)
      }
      case 'replaceable': {
        throw new Error('Not implemented')
      }
      default:
        throw new Error('Not implemented')
    }
  }

  getNearbyBlocks (world: World): BlockInfo[] {
    return [
      world.getBlockInfo(this.vec.offset(0, 1, 0)),
      world.getBlockInfo(this.vec.offset(0, -1, 0)),
      world.getBlockInfo(this.vec.offset(0, 0, -1)),
      world.getBlockInfo(this.vec.offset(0, 0, 1)),
      world.getBlockInfo(this.vec.offset(-1, 0, 0)),
      world.getBlockInfo(this.vec.offset(1, 0, 0))
    ]
  }

  needToPerform (bot: Bot): boolean {
    const blockInfo = bot.pathfinder.world.getBlockInfo(this.vec)
    if (blockInfo.isInvalid) {
      logPlace(`Block at ${this.vec} is invalid. needsToPerform: true`)
      return true
    }

    let needs = true
    switch (this.type) {
      case 'water': {
        needs = !(blockInfo.liquid && BlockInfo.waters.has(blockInfo.type))
        break
      }
      case 'solid': {
        needs = !blockInfo.physical
        break
      }
      case 'replaceable': {
        needs = !(blockInfo.replaceable)
        break
      }
    }

    // logPlace(`needToPerform at ${this.vec}? ${needs} (Type: ${this.type})`)
    return needs
  }

  async performInfo (bot: Bot, ticks = 15, scale = 0.5): Promise<InteractionPerformInfo> {
    switch (this.type) {
      case 'water': {
        throw new Error('Not implemented')
      }

      case 'solid': {
        const works = []

        for (let i = 0; i <= ticks; i++) {
          const ectx = EPhysicsCtx.FROM_BOT(bot.physicsUtil.engine, bot)
          const state = ectx.state

          // Lightweight physics simulation
          for (let j = 0; j < i; j++) {
            bot.physicsUtil.engine.simulate(ectx, bot.world)
          }

          const bb1 = state.getBB()
          const eyePos = state.pos.offset(0, state.eyeHeight, 0)

          const dx = eyePos.x - (this.vec.x + 0.5)
          const dy = eyePos.y - (this.vec.y + 0.5)
          const dz = eyePos.z - (this.vec.z + 0.5)

          const verts: Vec3[] = []
          const m = 0.05 // Tiny margin
          const M = 0.95

          // Top / Bottom Face (Center + 4 Corners)
          if (dy > 0) {
            verts.push(this.vec.offset(0.5, 1, 0.5), this.vec.offset(m, 1, m), this.vec.offset(M, 1, m), this.vec.offset(m, 1, M), this.vec.offset(M, 1, M))
          } else {
            verts.push(this.vec.offset(0.5, 0, 0.5), this.vec.offset(m, 0, m), this.vec.offset(M, 0, m), this.vec.offset(m, 0, M), this.vec.offset(M, 0, M))
          }

          // East / West Face (Center + 4 Corners)
          if (dx > 0) {
            verts.push(this.vec.offset(1, 0.5, 0.5), this.vec.offset(1, m, m), this.vec.offset(1, M, m), this.vec.offset(1, m, M), this.vec.offset(1, M, M))
          } else {
            verts.push(this.vec.offset(0, 0.5, 0.5), this.vec.offset(0, m, m), this.vec.offset(0, M, m), this.vec.offset(0, m, M), this.vec.offset(0, M, M))
          }

          // South / North Face (Center + 4 Corners)
          if (dz > 0) {
            verts.push(this.vec.offset(0.5, 0.5, 1), this.vec.offset(m, m, 1), this.vec.offset(M, m, 1), this.vec.offset(m, M, 1), this.vec.offset(M, M, 1))
          } else {
            verts.push(this.vec.offset(0.5, 0.5, 0), this.vec.offset(m, m, 0), this.vec.offset(M, m, 0), this.vec.offset(m, M, 0), this.vec.offset(M, M, 0))
          }

          let good = 0
          for (const vert of verts) {
            const rayRes: RayType | null = (await bot.world.raycast(
              eyePos,
              vert.minus(eyePos).normalize().scale(scale),
              PlaceHandler.reach / scale
            )) as unknown as RayType

            if (rayRes === null) continue

            const pos = rayRes.position.plus(faceToVec(rayRes.face))
            if (pos.equals(this.vec)) {
              if (bb1.containsVec(rayRes.intersect)) continue
              if (AABB.fromBlock(pos).intersects(bb1)) continue

              good++
              works.push(rayRes as unknown as RayType)
            }
          }

          // INSTANT EXIT: The moment we find a valid placement frame, return it!
          if (good > 0) {
            logPlace(`performInfo calculated for pos ${this.blockInfo.position}. ticks: ${i}, raycasts: ${good}`)
            return { ticks: i, tickAllowance: 0, shiftTick: Infinity, raycasts: works }
          }
        }

        logPlace(`performInfo failed to find placement path for pos ${this.blockInfo.position}. Returning Infinity.`)
        return { ticks: Infinity, tickAllowance: Infinity, shiftTick: Infinity, raycasts: works }
      }

      case 'replaceable': {
        throw new Error('Not implemented')
      }
      default: {
        throw new Error('Not implemented')
      }
    }
  }

  async perform (bot: Bot, item: Item | null, opts: InteractOpts = {}): Promise<void> {
    const curInfo = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }

    if (item === null) {
      logPlace('Error: Cannot perform placement with null item')
      throw new Error('Invalid item')
    }

    logPlace(`Starting perform sequence at ${this.vec} with ${item.name}`)

    switch (this.type) {
      case 'water': {
        if (item.name !== 'water_bucket') throw new Error('Invalid item')
        if (this.getCurrentItem(bot) !== item) await this.equipItem(bot, item)

        logPlace(`Looking at ${this.vec} to place water.`)
        await bot.lookAt(this.vec, this.settings.forceLook)
        bot.activateItem(this.offhand)
        logPlace('Water placed.')
        break
      }

      case 'solid': {
        if (this.getCurrentItem(bot) !== item) await this.equipItem(bot, item)

        const predictBlock = opts.predictBlock ?? true

        let works
        if (opts.info === undefined) {
          works = await this.performInfo(bot)
        } else works = opts.info

        let waitTicks = 0
        while (works.raycasts.length === 0) {
          waitTicks++
          await bot.waitForTicks(1)
          works = await this.performInfo(bot)
        }
        if (waitTicks > 0) logPlace(`Waited ${waitTicks} ticks for valid raycast intersections.`)

        const stateEyePos = bot.entity.position.offset(0, 1.62, 0)
        const lookDir = bot.util.getViewDir()
        works.raycasts.sort((a, b) => b.intersect.minus(stateEyePos).dot(lookDir) - a.intersect.minus(stateEyePos).dot(lookDir))

        const rayRes = works.raycasts[0]
        if (rayRes === undefined) {
          logPlace('Error: Failed to find valid rayRes after filtering.')

          throw new Error('Invalid block')
        }

        const pos = rayRes.position.plus(faceToVec(rayRes.face))
        const posBl = AABB.fromBlock(pos)

        console.log(bot.entity.position)
        logPlace(`Simulating movement ticks before placement (ticks needed: ${works.ticks})`)
        let i = 1
        for (; i <= works.ticks; i++) {
          const ectx = EPhysicsCtx.FROM_BOT(bot.physicsUtil.engine, bot)
          const state = ectx.state
          bot.physicsUtil.engine.simulate(ectx, bot.world)

          const sPos = state.pos.offset(0, 1.62, 0)
          const testCheck = (await bot.world.raycast(
            sPos,
            rayRes.intersect.minus(sPos).normalize().scale(0.5),
            PlaceHandler.reach * 2
          )) as unknown as RayType

          if (testCheck === null) {
            logPlace('what the fuck?')
            break
          }

          const pos1 = testCheck.position.plus(faceToVec(testCheck.face))
          const pos1Bl = AABB.fromBlock(pos1)
          if (testCheck.position.equals(rayRes.position) && testCheck.face === rayRes.face && !state.getBB().intersects(pos1Bl)) {
            // if (i < works.ticks && works.ticks !== 0) {
            logPlace(`Early exit from pre-placement simulation at tick ${i}/${works.ticks} due to favorable conditions. Current position: ${state.pos}, Ray intersect: ${rayRes.intersect}, Test check position: ${testCheck.position}, Test check face: ${testCheck.face}`)
            await bot.waitForTicks(1)
            // }
            // logPlace('what teh fuck 2?')
            break
          }
          logPlace(`Simulating tick ${i}/${works.ticks} before placement. Current position: ${state.pos}, Ray intersect: ${rayRes.intersect}, Test check position: ${testCheck.position}, Test check face: ${testCheck.face}`)
          await bot.waitForTicks(1)
        }

        const botBB = AABBUtils.getEntityAABBRaw({ position: bot.entity.position, width: 0.6, height: 1.8 })

        if (!this.move.isLookingAt(rayRes.intersect)) {
          logPlace(`Adjusting look toward raycast intersection at ${rayRes.intersect}`)
          void this.move.lookAt(rayRes.intersect)
          void bot.lookAt(rayRes.intersect, this.settings.forceLook)
        }

        const invalidPlacement = botBB.intersects(posBl)
        if (invalidPlacement) {
          logPlace(`Error: Invalid placement! Bot AABB intersects target placement AABB at ${posBl.bottomMiddlePoint()}. Age: ${i}, bot: ${bot.entity.position}, sim: ${botBB.bottomMiddlePoint()}`)
          await bot.lookAt(rayRes.intersect, this.settings.forceLook)
          throw new CancelError('Invalid placement')
        }

        const direction = faceToVec(rayRes.face)

        logPlace(`Calling bot._placeBlockWithOptions at face ${rayRes.face}`)
        this._placeTask = bot._placeBlockWithOptions(rayRes, direction, { forceLook: 'ignore', swingArm: 'right' })

        if (predictBlock) {
          logPlace(`Predicting block placement at ${rayRes.position.plus(direction)}`)
          bot.world.setBlock(rayRes.position.plus(direction), BlockInfo.PBlock.fromStateId(BlockInfo.substituteBlockStateId, 0))
        }

        this._internalLock = false

        if (opts.noAwait) {
          this._placeTask.catch((err) => logPlace('Background place task failed: %O', err))
        } else {
          await this._placeTask
          logPlace('_placeTask resolved.')
        }

        this.task?.finish()
        break
      }
      case 'replaceable':
      default: {
        throw new Error('Not implemented')
      }
    }

    if (opts.returnToPos !== undefined) {
      await bot.lookAt(opts.returnToPos, this.settings.forceLook)
    } else if (opts.returnToStart != null && opts.returnToStart) {
      await bot.look(curInfo.yaw, curInfo.pitch, this.settings.forceLook)
    }

    this._done = true
    this.performing = false
    delete this._placeTask
    logPlace(`Completed perform sequence at ${this.vec}`)
  }

  async abort (bot: Bot): Promise<void> {
    logPlace(`Aborting placement at ${this.vec}`)
    if ((this.task != null) && !this.task.done) {
      this.task.finish()
      this.task.canceled = true
    }

    if (this._placeTask != null) {
      await this._placeTask.catch((err) => {
        logPlace('Caught error during _placeTask abort: %O', err)
      })
    }
  }
}

export class BreakHandler extends InteractHandler {
  static reach = 4
  /** digs of a block the server puts back each time (refused breaks) before the break fails */
  static DIG_TRIES = 3
  private _breakTask?: Promise<void>

  /**
   * After the dig: true when the block stays gone for the settle's ticks (or `settled`, the wait for it, says it did),
   * false as soon as it is there (back, or never broken)
   */
  private async staysGone (bot: Bot, gone: (b: Block | null) => boolean, settled?: Promise<unknown>): Promise<boolean> {
    let done = false
    settled?.then(() => { done = true }, () => {})
    await Promise.resolve()
    for (let ticks = 0; !done && ticks < DEFAULT_SETTLE_TICKS; ticks++) {
      if (!gone(bot.blockAt(this.vec) as unknown as Block | null)) return false
      await bot.waitForTicks(1)
    }
    return done || gone(bot.blockAt(this.vec) as unknown as Block | null)
  }

  static fromVec (vec: Vec3, type: InteractType, offhand = false): BreakHandler {
    return new BreakHandler(vec.x, vec.y, vec.z, type, offhand)
  }

  toBlockInfo (): BlockInfo {
    return BlockInfo.AIR(this.vec)
  }

  getBlock (world: World): Block | null {
    return world.getBlock(this.vec)
  }

  getItem (bot: Bot, block: Block): Item | null {
    switch (this.type) {
      case 'water': {
        return bot.inventory.items().find((item) => item.name === 'bucket') ?? null // empty bucket
      }
      case 'solid': {
        // TODO: identify best tool for block.
        return bot.pathingUtil.bestHarvestingTool(block)
      }
      case 'replaceable': {
        throw new Error('Not implemented')
      }
      default:
        throw new Error('Not implemented')
    }
  }

  needToPerform (bot: Bot): boolean {
    const blockInfo = bot.pathfinder.world.getBlockInfo(this.vec)

    if (blockInfo.isInvalid) {
      logBreak(`Block at ${this.vec} is invalid. needsToPerform: true`)
      return true
    }

    const needs = !(blockInfo.block?.boundingBox === 'empty' && !BlockInfo.liquids.has(blockInfo.type))
    // logBreak(`needToPerform at ${this.vec}? ${needs}`)
    return needs
  }

  async performInfo (bot: Bot, ticks = 15): Promise<InteractionPerformInfo> {
    const bb = AABB.fromBlock(this.vec)
    const dist = bb.distanceToVec(bot.entity.position.offset(0, 1.62, 0))
    // in the crosshair's reach (the block_interaction_range): digInSight aims at a point of the block within it, and the
    // bot holds still while it digs (MovementExecutor.digging); from further off it walks on (it started digs 9 blocks
    // off, which the server refuses past the reach)
    const reachable = dist < blockReach(bot)

    logBreak(`performInfo calculation. Distance: ${dist.toFixed(2)}, Reachable: ${reachable}`)

    return reachable
      ? { ticks: 0, tickAllowance: 0, shiftTick: 0, raycasts: [] }
      : { ticks: Infinity, tickAllowance: Infinity, shiftTick: Infinity, raycasts: [] }
  }

  async perform (bot: Bot, item: Item | null = null, opts: InteractOpts = {}): Promise<void> {
    const curInfo = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
    logBreak(`Starting break sequence at ${this.vec}`)

    switch (this.type) {
      case 'water': {
        if (item === null) throw new Error('No item')
        if (item.name !== 'bucket') throw new Error('Invalid item')
        if (this.getCurrentItem(bot) !== item) await this.equipItem(bot, item)

        logBreak(`Looking at ${this.vec} to collect water.`)
        await bot.lookAt(this.vec, this.settings.forceLook)
        bot.activateItem(this.offhand)
        logBreak('Water collected.')
        break
      }

      case 'solid': {
        if (item === null) {
          if (this.getCurrentItem(bot) !== null) await bot.unequip(this.offhand ? 'off-hand' : 'hand')
        } else if (this.getCurrentItem(bot) !== item) {
          await this.equipItem(bot, item)
        }
        // the slot the tool is in goes to the server before the dig starts, as the held attack key sends it before the
        // dig goes on (MultiPlayerGameMode.continueDestroyBlock: ensureHasSentCarriedItem): mineflayer sends a slot
        // change at a later tick, and a dig started first was the old item's on the server, an instant break of the
        // client's (shears on a leaf) that the server only started, and put the block back
        ;(bot as any)._ensureHasSentCarriedItem?.()

        const gone =(b: Block | null): boolean => b != null && BlockInfo.replaceables.has(b.type)
        for (let tries = 1; ; tries++) {
          const block = await bot.world.getBlock(this.vec) as Block | null
          if (block == null) {
            logBreak('Error: Block is null')
            throw new Error('Invalid block')
          }

          // (a block already gone, a break predicted before this one started, isn't dug: whatever is behind it would be)
          let settled: Promise<unknown> | undefined
          const stop = new AbortController()
          if (!gone(block)) {
            logBreak(`Digging ${block.name} through the crosshair`)
            // the dig's own ticks (Player.getDestroySpeed, as bot.digTime) and some for the server's answer: the wait is
            // the game's time, not 5 s of wall clock, which a dig by hand (stone takes 7.5 s) or a loaded machine outlasts
            const digTicks = Math.ceil((bot.digTime?.(block) ?? 0) / 50)
            settled = waitForSettledBlockStateAtPosition(
              bot,
              this.blockInfo.position,
              gone,
              { timeoutMs: 0, timeoutTicks: digTicks + 100, settleTicks: DEFAULT_SETTLE_TICKS, signal: stop.signal }
            )
            settled.catch(() => {})
            // only the block the crosshair hits breaks, as vanilla's player breaks it (a leaf in front of it first)
            this._breakTask = digInSight(bot, block)
            // a dig that fails (aborted, out of reach) ends the wait with its error
            await Promise.race([settled, this._breakTask])
            logBreak('Dig task resolved. Now waiting for world update.')
          }

          // the dig is over: the block is broken once it stays gone for the settle's ticks. One back (or never gone) is
          // a break the server refused: the client's prediction (MultiPlayerGameMode.destroyBlock, the dig's end) put
          // back by the server's acknowledgement (BlockStatePredictionHandler.endPredictionsUpTo), as an instant break
          // by a tool the server didn't know was held yet (the slot sent at the next tick, ensureHasSentCarriedItem). A
          // player holding the attack key on it starts the dig again (Minecraft.continueAttack), and so does the bot.
          const broken = await this.staysGone(bot, gone, settled)
          stop.abort()
          if (broken) break
          if (this.task?.canceled === true) return
          if (tries >= BreakHandler.DIG_TRIES) throw new Error(`the ${block.name} at ${this.vec.toString()} came back after ${tries} digs`)
          logBreak(`the block at ${this.vec} came back: dig ${tries + 1}`)
        }

        // the block is gone: the dig's own promise gets a few ticks to answer (mineflayer's diggingCompleted), not
        // for good (a dig whose answer never came held the move's start until the caller gave up)
        const breakTask = this._breakTask
        if (breakTask != null) {
          let answered = false
          void breakTask.then(() => { answered = true }, () => { answered = true })
          for (let i = 0; i < DIG_ANSWER_TICKS && !answered; i++) await bot.waitForTicks(1)
          if (answered) await breakTask
        }

        if (this.task != null) this.task.finish()
        break
      }

      case 'replaceable': {
        throw new Error('Not implemented')
      }

      default: {
        throw new Error('Not implemented')
      }
    }

    if (opts.returnToPos !== undefined) {
      await bot.lookAt(opts.returnToPos, this.settings.forceLook)
    } else {
      const look = opts.returnToStart ?? false
      if (look) await bot.look(curInfo.yaw, curInfo.pitch, this.settings.forceLook)
    }

    delete this._breakTask
    logBreak(`Completed break sequence at ${this.vec}`)
  }

  async abort (bot: Bot): Promise<void> {
    logBreak(`Aborting break at ${this.vec}`)
    if ((this.task != null) && !this.task.done) {
      this.task.finish()
      this.task.canceled = true
    }

    if (this._breakTask != null) {
      switch (this.type) {
        case 'water': {
          break
        }
        case 'solid': {
          logBreak('Calling bot.stopDigging()')
          bot.stopDigging()
          break
        }
        case 'replaceable': {
          break
        }
      }
      await this._breakTask.catch((err) => {
        logBreak('Caught error during _breakTask abort: %O', err)
      })
    }
  }
}

const logOpen = debug('minecraft-pathfinding:OpenHandler')

/** ticks the server gets to answer a right click on a door, gate or trapdoor with its block update */
const USE_ANSWER_TICKS = 20
/** right clicks on a door that the server didn't answer before the move fails */
const USE_TRIES = 3

/**
 * A door, fence gate or trapdoor in the move's way, opened (or shut) with a right click as a player does it: the bot
 * stands, looks at a point of it in sight and uses it (useInSight: mineflayer-mouse's right click when loaded, else
 * activateBlock with the crosshair's face and point), then waits for the server's block update with its state as the
 * move needs it. A break for the executor's sake (the bot holds still while it is under way, MovementExecutor.digging),
 * that leaves the block in its toggled state (`blockInfo`, what the search's later nodes see), not air.
 */
export class OpenHandler extends BreakHandler {
  constructor (
    x: number, y: number, z: number,
    /** the block as the click leaves it */
    target: BlockInfo,
    /** the face of the cell the player's box goes to (passages.ts clearToFace), and which of its cells this is */
    public readonly faceX: number,
    public readonly faceZ: number,
    public readonly part: PassagePart,
    /** the move goes into the cell (`enter`) or out of it (`leave`), going (dirX, dirZ) */
    public readonly how: 'enter' | 'leave',
    public readonly dirX: number,
    public readonly dirZ: number
  ) {
    super(x, y, z, 'solid')
    ;(this as any).blockInfo = target
  }

  /** the block's state lets the player's box by (or the block is gone) */
  isClear (bot: Bot): boolean {
    const info = bot.pathfinder.world.getBlockInfo(this.vec)
    if (info.isInvalid) return false
    if (info.passage == null) return info.walkthrough || !info.physical
    return clearToFace(info.shapes, this.faceX, this.faceZ, this.part)
  }

  needToPerform (bot: Bot): boolean {
    return !this.isClear(bot)
  }

  /** the item in hand: a right click is made with whatever is held (a door's use takes no item) */
  getItem (bot: Bot): Item | null {
    return this.getCurrentItem(bot)
  }

  async performInfo (bot: Bot, ticks = 15): Promise<InteractionPerformInfo> {
    const eye = bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0)
    const reachable = AABB.fromBlock(this.vec).distanceToVec(eye) < blockReach(bot)
    return reachable
      ? { ticks: 0, tickAllowance: 0, shiftTick: 0, raycasts: [] }
      : { ticks: Infinity, tickAllowance: Infinity, shiftTick: Infinity, raycasts: [] }
  }

  /** whether the right click is still wanted: the state the move needs isn't there yet */
  protected wanted (bot: Bot): boolean {
    return this.needToPerform(bot)
  }

  async perform (bot: Bot, item: Item | null = null, opts: InteractOpts = {}): Promise<void> {
    for (let attempt = 0; attempt < USE_TRIES && this.wanted(bot); attempt++) {
      if (this.task?.canceled === true) return
      const block = bot.blockAt(this.vec) as unknown as Block | null
      if (block == null) throw new CancelError(`no block at ${this.vec.toString()}`)
      logOpen(`using the ${block.name} at ${this.vec}`)
      if (!(await useInSight(bot, block as any))) throw new CancelError(`the ${block.name} at ${this.vec.toString()} is not in sight`)
      // the server's answer: the block update of its new state (both of a door's halves)
      for (let tick = 0; tick < USE_ANSWER_TICKS && this.wanted(bot); tick++) await bot.waitForTicks(1)
    }
    if (this.wanted(bot)) throw new CancelError(`the block at ${this.vec.toString()} stayed as it was after ${USE_TRIES} right clicks`)
    this.task?.finish()
  }

  async abort (bot: Bot): Promise<void> {
    if ((this.task != null) && !this.task.done) {
      this.task.finish()
      this.task.canceled = true
    }
  }
}

/**
 * A door, gate or trapdoor the bot opened, shut behind it once it is through (closeGatesBehind, closeDoorsBehind): a
 * right click as the bot's box is past the block's closed shapes going (dirX, dirZ), from where it stands then. It
 * waits for the bot to get past; a door out of reach by then, or not in sight, is left open (the walk goes on).
 */
export class CloseHandler extends OpenHandler {
  private givenUp = false

  constructor (x: number, y: number, z: number, closed: BlockInfo, dirX: number, dirZ: number) {
    super(x, y, z, closed, 0, 0, 'feet', 'leave', dirX, dirZ)
  }

  /** the block is open still (as the bot left it), and not given up on */
  needToPerform (bot: Bot): boolean {
    if (this.givenUp) return false
    const info = bot.pathfinder.world.getBlockInfo(this.vec)
    if (info.passage == null) return false
    return info.block?.getProperties?.().open === true
  }

  /** whether the bot's box is past the block's shapes as the click shuts it */
  past (bot: Bot): boolean {
    const closed = bot.pathfinder.world.getBlockInfo(this.vec).toggled()
    if (closed == null) return true
    const pos = bot.entity.position
    return pastShapes(closed.shapes, this.dirX, this.dirZ, pos.x - this.x, pos.z - this.z)
  }

  async performInfo (bot: Bot, ticks = 15): Promise<InteractionPerformInfo> {
    const info = await super.performInfo(bot, ticks)
    if (info.ticks === Infinity) {
      // gone on out of reach of it: left open
      if (this.past(bot)) this.givenUp = true
      return info
    }
    return this.past(bot) ? info : { ticks: Infinity, tickAllowance: Infinity, shiftTick: Infinity, raycasts: [] }
  }

  async perform (bot: Bot, item: Item | null = null, opts: InteractOpts = {}): Promise<void> {
    try {
      await super.perform(bot, item, opts)
    } catch (err) {
      // not shut (not in sight from here, the server didn't answer): the walk goes on with it open
      logOpen(`left the block at ${this.vec} open: ${(err as Error)?.message ?? String(err)}`)
      this.givenUp = true
      this.task?.finish()
    }
  }
}
