import { BaseSimulator, BotcraftPhysics, EPhysicsCtx } from '@nxg-org/mineflayer-physics-util'
import { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { Move } from '../move'
import { World } from '../world/worldInterface'
import { BlockInfo } from '../world/cacheWorld'
import { BreakHandler, CloseHandler, InteractHandler, OpenHandler, PlaceHandler } from './interactionUtils'
import { clearToFace, PassageKind, PassagePart } from '../world/passages'
import type { InteractType } from './interactionUtils'
import type { Block } from '../../types'
import { Vec3Properties } from '../../types'
import { COST_INF, SPRINT_ONE_BLOCK_COST, WALK_ONE_BLOCK_COST, WALK_ONE_IN_WATER_COST } from './costs'
import type { ExclusionArea } from './exclusionZones'
import { DEFAULT_SCAFFOLDING_BLOCKS } from './scaffolding'

export interface MovementOptions {
  allowDiagonalBridging: boolean
  allowJumpSprint: boolean
  allow1by1towers: boolean

  // --- Cost knobs (all in GAME TICKS; see costs.ts) -----------------------
  /** Extra ticks per block when moving through liquid (water is slow). */
  liquidCost: number
  /** Multiplier on a block's real mining time. 1 = use the true dig time as-is. */
  digCost: number
  /** Extra ticks charged per jump, on top of the physical jump arc. 0 = trust the physics. */
  jumpCost: number
  /** Ticks charged for placing a block. Placing interrupts movement, so it is deliberately costly. */
  placeCost: number
  /** Ticks charged for killing horizontal velocity (e.g. stopping at the edge of a drop). */
  velocityKillCost: number
  /**
   * Ticks charged on top for a jump up a block with a deadly fall beside it (Movement.jumpHazard: lava, fire, or no
   * ground within a safe drop next to its start or its landing), which the executor runs up to from a standstill
   */
  hazardJumpCost: number
  /**
   * Ticks charged on top for each side of the cell a move ends in that has a deadly fall beside it (Movement.deadlyFall:
   * lava or fire, or no ground within a safe drop): a knockback, a slide or a step off the line comes down there (a
   * diagonal across two pits' corners, a ledge over the nether's lava sea). 0 is none
   */
  edgeHazardCost: number

  forceLook: boolean
  /** go through closed wooden doors, fence gates and trapdoors by opening them (the iron ones are walls) */
  canOpenDoors: boolean
  /** ticks charged for opening a door, gate or trapdoor (a stop, a look and a right click the server answers) */
  openCost: number
  /** shut a fence gate the bot opened once it is through (so that a pen's animals stay in) */
  closeGatesBehind: boolean
  /** shut a door or trapdoor the bot opened once it is through: always, never, or by night (so that mobs stay out) */
  closeDoorsBehind: boolean | 'night'
  canDig: boolean
  canPlace: boolean
  /**
   * the blocks the bot builds with (bridges, towers, a floor under a step), as item names, cheapest first: the search's
   * budget counts every one the inventory holds, and a place takes the first it holds (DEFAULT_SCAFFOLDING_BLOCKS:
   * full solid blocks that don't fall, with no block entity, worth little)
   */
  scaffoldingBlocks: string[]
  /**
   * blocks of the scaffolding (scaffoldingBlocks) the search leaves out of its plans: a path places at most what the
   * inventory holds less these, so that the bot is never left mid-bridge with none (a place that failed and was tried
   * again, a block the bot used for something else)
   */
  scaffoldReserve: number
  dontCreateFlow: boolean
  dontMineUnderFallingBlock: boolean

  maxDropDown: number
  infiniteLiquidDropdownDistance: boolean
  allowSprinting: boolean
  careAboutLookAlignment: boolean

  movementTimeoutMs: number

  /**
   * "Keep out" rules for blocks the bot would STAND in / walk into.
   *
   * Each {@link ExclusionArea} is a function that returns the extra cost of a
   * block (return `>= COST_INF` to forbid it entirely). The cost of every area
   * in the list is added together. An empty list (the default) means "no zones",
   * and costs nothing to evaluate.
   *
   * Write your own; ready-to-copy box/radius helpers live in
   * `examples/exclusionZones.js`.
   */
  exclusionAreasStep: ExclusionArea[]

  /** "Keep out" rules for blocks the bot would BREAK (mine). See {@link exclusionAreasStep}. */
  exclusionAreasBreak: ExclusionArea[]

  /** "Keep out" rules for blocks the bot would PLACE (build on). See {@link exclusionAreasStep}. */
  exclusionAreasPlace: ExclusionArea[]
}

export const DEFAULT_MOVEMENT_OPTS: MovementOptions = {
  allowJumpSprint: true,
  canOpenDoors: true,
  openCost: 5,
  closeGatesBehind: true,
  closeDoorsBehind: 'night',
  canDig: true,
  canPlace: true,
  scaffoldingBlocks: DEFAULT_SCAFFOLDING_BLOCKS as string[],
  scaffoldReserve: 4,
  dontCreateFlow: true,
  dontMineUnderFallingBlock: true,
  allow1by1towers: true,
  maxDropDown: 3,
  infiniteLiquidDropdownDistance: true,
  allowSprinting: true,
  // Extra time water adds over walking the same block on land (~4.46 ticks).
  liquidCost: WALK_ONE_IN_WATER_COST - WALK_ONE_BLOCK_COST,
  // Baritone's block-placement penalty: building a block to stand on is slow.
  placeCost: 20,
  // Keep a block's real mining time as-is (1x). Raise to make digging look worse.
  digCost: 1,
  // The jump arc already has a real tick cost (see JUMP_ONE_BLOCK_COST); add no fudge on top.
  jumpCost: 0,
  velocityKillCost: 2, // implement at a later date.
  // a jump by a deadly drop: a stop and a standing jump, and any other way that's a few blocks longer before it
  hazardJumpCost: 20,
  // a ledge by a deadly drop: a block or two round before a walk along it (more widens the search: the A* looks at
  // every node cheaper than the path it finds)
  edgeHazardCost: 4,
  forceLook: true,
  careAboutLookAlignment: true,
  allowDiagonalBridging: true,
  movementTimeoutMs: 1000,
  // No exclusion zones by default. Add your own with bot.pathfinder.setMoveOptions(...).
  exclusionAreasStep: [],
  exclusionAreasBreak: [],
  exclusionAreasPlace: []
}

// Lock the default exclusion lists so the single shared instances above can never
// be mutated in place. Real settings always receive their own fresh arrays via
// buildMovementOptions() below, so this is just a safety net.
Object.freeze(DEFAULT_MOVEMENT_OPTS.exclusionAreasStep)
Object.freeze(DEFAULT_MOVEMENT_OPTS.exclusionAreasBreak)
Object.freeze(DEFAULT_MOVEMENT_OPTS.exclusionAreasPlace)

/**
 * Merge user-supplied movement options on top of {@link DEFAULT_MOVEMENT_OPTS}
 * and return a complete {@link MovementOptions}.
 *
 * The three exclusion-area lists are ALWAYS returned as their own fresh arrays.
 * The defaults hold a single shared `[]` per list, so copying here is what stops
 * two different bots — or two `setMoveOptions` calls — from accidentally sharing
 * (and then mutating) the same array. Use this everywhere instead of a bare
 * `Object.assign({}, DEFAULT_MOVEMENT_OPTS, settings)`.
 */
export function buildMovementOptions (settings: Partial<MovementOptions> = {}): MovementOptions {
  const merged = Object.assign({}, DEFAULT_MOVEMENT_OPTS, settings)
  merged.exclusionAreasStep = [...merged.exclusionAreasStep]
  merged.exclusionAreasBreak = [...merged.exclusionAreasBreak]
  merged.exclusionAreasPlace = [...merged.exclusionAreasPlace]
  merged.scaffoldingBlocks = [...merged.scaffoldingBlocks]
  return merged
}

/**
 * Sum the extra cost every exclusion area in `areas` assigns to `block`.
 *
 * Returns 0 immediately when the list is empty (the normal case), so it is
 * essentially free unless the user opted in to exclusion zones.
 */
export function sumExclusionAreas (areas: ExclusionArea[], block: BlockInfo): number {
  if (areas.length === 0) return 0
  let weight = 0
  for (const area of areas) weight += area(block)
  return weight
}

/** the blocks that set a player alight (lava, fire, soul fire), by registry */
const burningByRegistry = new WeakMap<object, Set<number>>()
function burningBlocks (registry: Bot['registry']): Set<number> {
  let set = burningByRegistry.get(registry)
  if (set == null) {
    set = new Set<number>()
    for (const name of ['lava', 'fire', 'soul_fire']) {
      const id = registry.blocksByName[name]?.id
      if (id != null) set.add(id)
    }
    burningByRegistry.set(registry, set)
  }
  return set
}

const cardinalVec3s: Vec3[] = [
  // { x: -1, z: 0 }, // West
  // { x: 1, z: 0 }, // East
  // { x: 0, z: -1 }, // North
  // { x: 0, z: 1 }, // South
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1)
]

Object.freeze(cardinalVec3s)
cardinalVec3s.forEach(Object.freeze)

const diagonalVec3s: Vec3[] = [
  // { x: -1, z: -1 },
  // { x: -1, z: 1 },
  // { x: 1, z: -1 },
  // { x: 1, z: 1 },
  new Vec3(-1, 0, -1),
  new Vec3(-1, 0, 1),
  new Vec3(1, 0, -1),
  new Vec3(1, 0, 1)
]

Object.freeze(diagonalVec3s)
diagonalVec3s.forEach(Object.freeze)

const jumpVec3s: Vec3[] = [
  new Vec3(-3, 0, 0),
  new Vec3(-2, 0, 1),
  new Vec3(-2, 0, -1),
  new Vec3(-1, 0, 2),
  new Vec3(-1, 0, -2),
  new Vec3(0, 0, 3),
  new Vec3(0, 0, -3),
  new Vec3(1, 0, 2),
  new Vec3(1, 0, -2),
  new Vec3(2, 0, 1),
  new Vec3(2, 0, -1),
  new Vec3(3, 0, 0)
]

Object.freeze(jumpVec3s)
jumpVec3s.forEach(Object.freeze)

/**
 * TODO: Separate calculation time from runtime.
 *
 * Calculation time is when the bot is deciding what to do.
 * Runtime is when the bot is actually doing it.
 *
 * This class is currently bloated by providing two functions.
 * It should be broken up.
 */

export abstract class Movement {
  static readonly cardinalDirs = cardinalVec3s
  static readonly diagonalDirs = diagonalVec3s
  static readonly jumpDirs = jumpVec3s

  public readonly bot: Bot
  public readonly world: World
  public settings: MovementOptions

  /**
   * Current move being executed.
   *
   * This move is the same as the thisMove argument provided to functions.
   */
  protected currentMove!: Move

  /**
   * Current interaction.
   */
  protected _cI?: InteractHandler

  public constructor (bot: Bot, world: World, settings: Partial<MovementOptions> = {}) {
    this.bot = bot
    this.world = world
    this.settings = buildMovementOptions(settings)
  }

  loadMove (move: Move): void {
    this.currentMove = move
  }

  /**
   * Whether an interaction of the move is still to be done: not let go of, and its block not yet as the move needs it
   * (unless it is under way). A block the world has as needed already (a floor placed by an earlier try of the move,
   * a block another player put there, a leaf that decayed) is done: counted on, the move was never complete, and the
   * bot stood at its exit with no key held until the no-progress check failed it.
   */
  protected stillToDo (handler: InteractHandler): boolean {
    return !handler.allowExit && (handler.isPerforming || handler.needToPerform(this.bot))
  }

  toBreak (): BreakHandler[] {
    return this.currentMove.toBreak?.filter((b) => this.stillToDo(b)) ?? []
  }

  toBreakLen (): number {
    return this.toBreak().length
  }

  toPlace (): PlaceHandler[] {
    return this.currentMove.toPlace?.filter((b) => this.stillToDo(b)) ?? []
  }

  toPlaceLen (): number {
    return this.toPlace().length
  }

  getBlock (pos: Vec3Properties, dx: number, dy: number, dz: number): Block | null {
    return this.world.getBlock(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
  }

  getBlockInfo (pos: Vec3Properties, dx: number, dy: number, dz: number): BlockInfo {
    const yes = new Vec3(Math.floor(pos.x + dx), Math.floor(pos.y + dy), Math.floor(pos.z + dz))
    return this.world.getBlockInfo(yes)
  }

  getBlockInfoRaw (pos: Vec3): BlockInfo {
    return this.world.getBlockInfo(pos)
  }

  /**
   * Returns if a block is safe or not
   * @param pos
   * @returns
   */
  safe (pos: Vec3Properties): number {
    const block = this.world.getBlockInfo(new Vec3(pos.x, pos.y, pos.z))
    return block.physical ? 0 : COST_INF
  }

  /**
   * Whether a fall into the column dx, dz off `pos`, from feet level dy, is one to die of: lava or fire on the way
   * down, or no ground (or water) within maxDropDown + 1 blocks under it (LivingEntity.causeFallDamage: a fall over 3
   * blocks hurts). A column the world doesn't have loaded isn't counted.
   */
  deadlyFall (pos: Vec3Properties, dx: number, dy: number, dz: number): boolean {
    const burning = burningBlocks(this.bot.registry)
    for (let y = dy; y >= dy - (this.settings.maxDropDown + 1); y--) {
      const info = this.getBlockInfo(pos, dx, y, dz)
      if (info.isInvalid) return false
      if (burning.has(info.type)) return true
      if (info.physical || info.liquid) return false
    }
    return true
  }

  /**
   * Whether a jump up a block from `pos`'s block `dir` on (a cardinal) has a deadly fall beside it (deadlyFall): to
   * either side of its start, to either side of its landing or past it, the columns a jump that goes wrong (a run-up
   * off the line, a slide on landing) comes down in
   */
  jumpHazard (pos: Vec3Properties, dir: Vec3Properties): boolean {
    const sx = dir.z
    const sz = dir.x
    return this.deadlyFall(pos, sx, 0, sz) || this.deadlyFall(pos, -sx, 0, -sz) ||
      this.deadlyFall(pos, dir.x + sx, 1, dir.z + sz) || this.deadlyFall(pos, dir.x - sx, 1, dir.z - sz) ||
      this.deadlyFall(pos, 2 * dir.x, 1, 2 * dir.z)
  }

  /**
   * Ticks to travel `blocks` blocks of flat ground.
   *
   * The bot sprints when allowed (the fastest way to move), otherwise it walks.
   * Pass `1` for one straight block, `Math.SQRT2` for one diagonal block, etc.
   */
  travelCost (blocks: number): number {
    return blocks * (this.settings.allowSprinting ? SPRINT_ONE_BLOCK_COST : WALK_ONE_BLOCK_COST)
  }

  /**
   * Extra cost of ending a move in this block: the step exclusion areas (exclusionStep), its deadly edges
   * (edgeHazard), and COST_INF for a cell of water the bot can't keep in (waterUnstandable) unless the move is the
   * climb of a water column it is in (`waterColumn`: StraightUp's)
   */
  standCost (block: BlockInfo, opts: { waterColumn?: boolean } = {}): number {
    if (opts.waterColumn !== true && this.waterUnstandable(block)) return COST_INF
    return this.exclusionStep(block) + this.edgeHazard(block)
  }

  /**
   * The level of the fluid in a liquid cell (FlowingFluid's LEVEL: 0 a source, 1 to 7 flowing, 8 and up falling); 0
   * for a waterlogged block, and for a liquid cell whose state says none (a source's); null for no liquid
   */
  fluidLevel (block: BlockInfo): number | null {
    if (!block.liquid) return null
    let level: unknown
    try {
      level = (block.block as any)?.getProperties?.()?.level
    } catch {}
    const n = typeof level === 'number' ? level : typeof level === 'string' ? Number(level) : 0
    return Number.isFinite(n) ? n : 0
  }

  /**
   * Whether a liquid cell is flowing: its own fluid not a full block's (a level 1 to 7), or beside a cell that is
   * (a full cell next to a partial flow: the current pushes the bot off), as Baritone's isFlowing has it
   */
  isFlowing (block: BlockInfo): boolean {
    const partial = (b: BlockInfo): boolean => {
      const level = this.fluidLevel(b)
      return level != null && level >= 1 && level <= 7
    }
    if (!block.liquid) return false
    if (partial(block)) return true
    for (const dir of Movement.cardinalDirs) {
      if (partial(this.getBlockInfo(block.position, dir.x, 0, dir.z))) return true
    }
    return false
  }

  /**
   * Whether a move may not end with the feet in this cell for its water: the feet's cell or the head's flowing
   * (isFlowing), or the head's cell water too (the head under water: a swimmer's node is the water's top cell, where
   * it can breathe and its jump keeps it). Baritone's canWalkThrough takes water only so: still, with no fluid over it.
   */
  waterUnstandable (feet: BlockInfo): boolean {
    const head = this.getBlockInfo(feet.position, 0, 1, 0)
    if (feet.liquid && (head.liquid || this.isFlowing(feet))) return true
    return head.liquid && this.isFlowing(head)
  }

  /**
   * edgeHazardCost for each of the four sides of the cell (its feet's block) with a deadly fall beside it (deadlyFall
   * from the feet's level down): a player knocked back (LivingEntity.knockback), sliding on, or drifting off the
   * line of a walk goes over that side
   */
  edgeHazard (block: BlockInfo): number {
    const cost = this.settings.edgeHazardCost
    if (!(cost > 0)) return 0
    let sides = 0
    for (const dir of Movement.cardinalDirs) if (this.deadlyFall(block.position, dir.x, 0, dir.z)) sides++
    return sides * cost
  }

  /** Extra cost of STANDING in this block (sum of every step exclusion area; 0 if none). */
  exclusionStep (block: BlockInfo): number {
    return sumExclusionAreas(this.settings.exclusionAreasStep, block)
  }

  /** Extra cost of BREAKING this block (sum of every break exclusion area; 0 if none). */
  exclusionBreak (block: BlockInfo): number {
    return sumExclusionAreas(this.settings.exclusionAreasBreak, block)
  }

  /** Extra cost of PLACING a block here (sum of every place exclusion area; 0 if none). */
  exclusionPlace (block: BlockInfo): number {
    return sumExclusionAreas(this.settings.exclusionAreasPlace, block)
  }

  /**
   * Whether this block is allowed to be broken at all (ignoring cost).
   *
   * This only answers the "is it physically/configurably breakable" question
   * (can we dig, would it create flowing water, would a block fall on us, is it
   * an unbreakable block like bedrock). The "is it inside a no-mining zone"
   * question is handled separately as a cost, in {@link breakCost} via
   * {@link exclusionBreak}.
   * @param {BlockInfo} block
   * @returns
   */
  safeToBreak (block: BlockInfo): boolean {
    if (!this.settings.canDig) {
      return false
    }

    if (this.settings.dontCreateFlow) {
      if (!block.additionalLoaded) block.loadAdditionalInfo(this)
      if (block.waterAround) return false
    }

    if (this.settings.dontMineUnderFallingBlock) {
      if (!block.additionalLoaded) block.loadAdditionalInfo(this)
      // TODO: Determine if there are other blocks holding the entity up
      if (block.fallBlockOver) return false
      // if (this.getBlockInfo(block.position, 0, 1, 0).canFall) {
      //   // || (this.getNumEntitiesAt(block.position, 0, 1, 0) > 0)
      //   return false
      // }
    }

    // console.log('block type:', this.bot.registry.blocks[block.type], block.position, !BlockInfo.blocksCantBreak.has(block.type))
    return BlockInfo.replaceables.has(block.type) || !BlockInfo.blocksCantBreak.has(block.type)
  }

  /**
   * Cost of either walking through `block` (if it is already passable) or
   * breaking it so the bot can pass.
   *
   * Returns `COST_INF` (or more) when the block cannot be used — for example an
   * unbreakable block, or one inside a break-exclusion zone (see
   * {@link breakCost} / {@link exclusionBreak}). Step-exclusion zones are NOT
   * checked here; each movement provider applies {@link exclusionStep} to the
   * block the bot lands in, folding the cost in before the move is created.
   * @param {BlockInfo} block block
   * @param {BreakHandler[]} toBreak
   * @returns {number}
   */
  safeOrBreak (block: BlockInfo, toBreak: BreakHandler[]): number {
    // cost += this.getNumEntitiesAt(block.position, 0, 0, 0) * this.entityCost

    // if (block.breakCost !== undefined) return block.breakCost // cache breaking cost.

    if (block.walkthrough) {
      // if (!block.replaceable) toBreak.push(BreakHandler.fromVec(block.position, "solid"));
      return 0 // TODO: block is a carpet or a climbable (BUG)
    }

    if (block.block === null) return COST_INF // Don't know its type, but that's only replaceables so just return.

    // a door, gate or trapdoor is gone through by its shapes or opened (safeOrOpen), never dug: it is part of
    // someone's house or pen
    if (block.passage != null) return COST_INF

    if (!this.safeToBreak(block)) return COST_INF // Can't break, so can't move

    const cost = this.breakCost(block)

    // console.log('cost for:', block.position, cost)

    if (cost >= COST_INF) return cost

    // TODO: Calculate cost of breaking block
    // if (block.physical) cost += this.getNumEntitiesAt(block.position, 0, 1, 0) * this.entityCost // Add entity cost if there is an entity above (a breakable block) that will fall
    toBreak.push(BreakHandler.fromVec(block.position, 'solid'))

    return cost
  }

  /**
   * Cost of the player's box going through a cell of a door, fence gate or trapdoor (`part`: the feet's cell or the
   * head's), moving `dir` (a cardinal): into it, from the face behind to its middle (`enter`), or out of it, from its
   * middle by the face ahead (`leave`). 0 when its state's collision shapes leave the box room (an open door's panel
   * along a side, an open gate); when a right click opens it so they do, the open cost, with an OpenHandler pushed to
   * toBreak (one per door: its other half opens with it); else (an iron door, a closed one with canOpenDoors off)
   * COST_INF. A cell of any other block: safeOrBreak to go into it, 0 to leave it.
   */
  safeOrOpen (block: BlockInfo, dir: Vec3Properties, part: PassagePart, how: 'enter' | 'leave', toBreak: BreakHandler[]): number {
    if (block.passage == null) return how === 'enter' ? this.safeOrBreak(block, toBreak) : 0
    const faceX = how === 'enter' ? -dir.x : dir.x
    const faceZ = how === 'enter' ? -dir.z : dir.z
    if (clearToFace(block.shapes, faceX, faceZ, part)) return 0
    if (!this.settings.canOpenDoors || !BlockInfo.openable.has(block.type)) return COST_INF
    const target = block.toggled()
    if (target == null || !clearToFace(target.shapes, faceX, faceZ, part)) return COST_INF
    // a door's two halves open with one click (DoorBlock.setOpen sets both): the second costs nothing more
    const sameDoor = block.passage === 'door' && toBreak.some((h) => h instanceof OpenHandler && h.x === block.position.x &&
      h.z === block.position.z && Math.abs(h.y - block.position.y) === 1)
    toBreak.push(new OpenHandler(block.position.x, block.position.y, block.position.z, target, faceX, faceZ, part, how, dir.x, dir.z))
    return sameDoor ? 0 : this.settings.openCost
  }

  /** whether a door, gate or trapdoor of this kind the bot opened is shut behind it (closeGatesBehind, closeDoorsBehind) */
  shutsBehind (kind: PassageKind): boolean {
    if (kind === 'gate') return this.settings.closeGatesBehind
    const doors = this.settings.closeDoorsBehind
    // night as the game's clock has it (mineflayer's time.isDay: day from 23000 to 13000)
    return doors === 'night' ? (this.bot.time as any)?.isDay === false : doors
  }

  /**
   * The doors, gates and trapdoors to shut once the bot is through, as the move going `dir` from `start` leaves them:
   * the one it opens in the cell it leaves, and the one the move before opened going into that cell. A CloseHandler is
   * pushed to toBreak for each (both of a door's halves, the second's click free), with the cost of the click.
   */
  closeBehind (start: Move, dir: Vec3Properties, toBreak: BreakHandler[]): number {
    const opened: OpenHandler[] = []
    for (const h of toBreak) if (h instanceof OpenHandler && !(h instanceof CloseHandler) && h.how === 'leave') opened.push(h)
    for (const h of start.toBreak) {
      if (h instanceof OpenHandler && !(h instanceof CloseHandler) && h.how === 'enter' && h.x === start.x && h.z === start.z) opened.push(h)
    }
    let cost = 0
    for (const h of opened) {
      const kind = BlockInfo.passages.get(h.blockInfo.type)
      if (kind == null || !this.shutsBehind(kind)) continue
      const closed = h.blockInfo.toggled()
      if (closed == null) continue
      if (toBreak.some((c) => c instanceof CloseHandler && c.x === h.x && c.y === h.y && c.z === h.z)) continue
      const sameDoor = toBreak.some((c) => c instanceof CloseHandler && c.x === h.x && c.z === h.z && Math.abs(c.y - h.y) === 1)
      toBreak.push(new CloseHandler(h.x, h.y, h.z, closed, dir.x, dir.z))
      if (!sameDoor) cost += this.settings.openCost
    }
    return cost
  }

  /**
   * Ticks to break (mine) `block` with the bot's best tool.
   *
   * `pathingUtil.digCost` returns the real dig time in MILLISECONDS, and the
   * game runs at 20 ticks/s (50 ms/tick), so `ms / 50` is the dig time in ticks
   * — the same unit as every other movement cost. `digCost` (default 1) is a
   * multiplier so callers can make mining look cheaper or dearer.
   */
  breakCost (block: BlockInfo): number {
    if (block.block === null) return COST_INF // Don't know its type, but that's only replaceables so just return.

    const digTimeMs = this.bot.pathingUtil.digCost(block.block)
    const miningTicks = (digTimeMs / 50) * this.settings.digCost

    // Add the break-exclusion penalty (0 unless the user configured "no mining" zones).
    // If the block sits inside a forbidden zone this pushes the cost past COST_INF,
    // which every caller treats as "do not break this block".
    return miningTicks + this.exclusionBreak(block)
  }

  safeOrPlace (block: BlockInfo, toPlace: PlaceHandler[], type: InteractType = 'solid'): number {
    if (!this.settings.canPlace) return COST_INF
    // the blocks the move places before this one come out of the budget too (a diagonal's two)
    if (this.currentMove.remainingBlocks - toPlace.length <= 0) return COST_INF

    if (block.block === null) return COST_INF // Don't know its type, but that's only replaceables so just return.
    if (block.solidFull) return 0 // block is already physical at location.

    const cost = this.placeCost(block)

    if (cost >= COST_INF) return cost
    toPlace.push(PlaceHandler.fromVec(block.position, type))

    return cost
  }

  /**
   * TODO: calculate more accurate place costs.
   */
  placeCost (block: BlockInfo): number {
    // Add the place-exclusion penalty (0 unless the user configured "no building" zones).
    // A forbidden zone pushes this past COST_INF, which callers treat as "do not place here".
    return this.settings.placeCost + this.exclusionPlace(block)
  }
}

export abstract class SimMovement extends Movement {
  stateCtx: EPhysicsCtx
  sim: BaseSimulator
  constructor (bot: Bot, world: World, settings: Partial<MovementOptions>) {
    super(bot, world, settings)
    this.sim = new BaseSimulator(new BotcraftPhysics(bot.registry))
    this.stateCtx = EPhysicsCtx.FROM_BOT(this.sim.ctx, bot)
  }

  simulateUntil (...args: Parameters<BaseSimulator['simulateUntil']>): ReturnType<BaseSimulator['simulateUntil']> {
    return this.sim.simulateUntil(...args)
  }
}
