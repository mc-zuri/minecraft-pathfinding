/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { Block } from '../types'
import type { Move } from '../mineflayer-specific/move'
import type { ThePathfinder } from '../ThePathfinder'
import type { BlockInfo } from '../mineflayer-specific/world/cacheWorld'
import { sumExclusionAreas } from '../mineflayer-specific/movements/movement'
import { COST_INF } from '../mineflayer-specific/movements/costs'
import type { XYZ } from './predictionCheck'

/** a block as a report shows it: its name, its state's properties when it has any, and its state id */
export function describeBlock (block: Block | null | undefined): string {
  if (block == null) return 'unloaded'
  const props = typeof (block as any).getProperties === 'function' ? (block as any).getProperties() : null
  const entries = props != null ? Object.entries(props) : []
  const shown = entries.length > 0 ? `[${entries.map(([k, v]) => `${k}=${String(v)}`).join(',')}]` : ''
  return `${block.name}${shown}#${String(block.stateId)}`
}

export interface BlockCell {
  /** the offset from the report's origin */
  at: XYZ
  block: string
}

export interface CacheDisagreement {
  pos: XYZ
  cache: string
  world: string
}

export interface BlocksAround {
  /** the bot's block: the cells are offsets from it */
  origin: XYZ
  radius: number
  /** every cell that isn't air */
  blocks: BlockCell[]
  air: number
  unloaded: number
  /** the cells the pathfinder's cache holds */
  cached: number
  /** the cells whose cached block isn't the world's */
  disagreements: CacheDisagreement[]
}

/** what the cache holds for a cell, without reading the world (CacheSyncWorld.peekBlockInfo) */
export interface PeekableCache {
  peekBlockInfo?: (pos: Vec3) => BlockInfo | undefined
}

/**
 * The cells whose block the pathfinder's cache holds and the world has another (by state id): the cache plans on what
 * it holds, the bot moves in the world.
 */
export function diffCacheWithWorld (positions: Iterable<Vec3>, cache: PeekableCache, worldBlock: (pos: Vec3) => Block | null): { cached: number, disagreements: CacheDisagreement[] } {
  const disagreements: CacheDisagreement[] = []
  let cached = 0
  if (typeof cache.peekBlockInfo !== 'function') return { cached, disagreements }
  for (const pos of positions) {
    const info = cache.peekBlockInfo(pos)
    if (info == null) continue
    cached++
    const world = worldBlock(pos)
    const cachedBlock = info.block
    const cachedState = cachedBlock?.stateId ?? null
    const worldState = world?.stateId ?? null
    if (cachedState !== worldState || (cachedBlock == null && world != null)) {
      disagreements.push({ pos: [pos.x, pos.y, pos.z], cache: cachedBlock != null ? describeBlock(cachedBlock) : `type ${String(info.type)}`, world: describeBlock(world) })
    }
  }
  return { cached, disagreements }
}

/** the blocks in the cube of `radius` about `center`'s block, and where the cache disagrees with the world */
export function blocksAround (center: Vec3, radius: number, worldBlock: (pos: Vec3) => Block | null, cache: PeekableCache = {}): BlocksAround {
  const origin = center.floored()
  const blocks: BlockCell[] = []
  const positions: Vec3[] = []
  let air = 0
  let unloaded = 0
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const pos = origin.offset(dx, dy, dz)
        positions.push(pos)
        const block = worldBlock(pos)
        if (block == null) unloaded++
        else if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') air++
        else blocks.push({ at: [dx, dy, dz], block: describeBlock(block) })
      }
    }
  }
  const { cached, disagreements } = diffCacheWithWorld(positions, cache, worldBlock)
  return { origin: [origin.x, origin.y, origin.z], radius, blocks, air, unloaded, cached, disagreements }
}

export interface MoveInfo {
  type: string
  from: XYZ
  to: XYZ
  cost: number
  breaks: XYZ[]
  places: XYZ[]
}

export function describeMove (move: Move): MoveInfo {
  const r = (n: number): number => Math.round(n * 1000) / 1000
  return {
    type: move.moveType.constructor.name,
    from: [r(move.entryPos.x), r(move.entryPos.y), r(move.entryPos.z)],
    to: [r(move.exitPos.x), r(move.exitPos.y), r(move.exitPos.z)],
    cost: r(move.cost),
    breaks: move.toBreak.map((b) => [b.x, b.y, b.z]),
    places: move.toPlace.map((p) => [p.x, p.y, p.z])
  }
}

/** a goal's own fields, as plain data (a Vec3 as [x, y, z]) */
export function describeGoal (goal: unknown): Record<string, unknown> | null {
  if (goal == null || typeof goal !== 'object') return null
  const out: Record<string, unknown> = { type: (goal as object).constructor?.name ?? 'Goal' }
  for (const [k, v] of Object.entries(goal as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[k] = v
    else if (v instanceof Vec3) out[k] = [v.x, v.y, v.z]
    else if (v != null && typeof v === 'object' && (v as any).position instanceof Vec3) out[k] = { id: (v as any).id, name: (v as any).name, position: [(v as any).position.x, (v as any).position.y, (v as any).position.z] }
  }
  return out
}

/** the block a goal names (GoalBlock, GoalNear, GoalGetToBlock, ... keep it as x, y, z), if it names one */
export function goalBlock (goal: unknown): Vec3 | null {
  const g = goal as { x?: unknown, y?: unknown, z?: unknown, pos?: unknown } | null
  if (g == null) return null
  if (typeof g.x === 'number' && typeof g.y === 'number' && typeof g.z === 'number') return new Vec3(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z))
  if (g.pos instanceof Vec3) return g.pos.floored()
  return null
}

export interface PathState {
  isPathing: boolean
  goal: Record<string, unknown> | null
  currentIndex: number
  /** the path's moves from the current one on (at most 40) */
  remaining: MoveInfo[]
  remainingTotal: number
  currentMove: MoveInfo | null
  executor: { type: string, interaction: { type: string, pos: XYZ, done: boolean, performing: boolean } | null, aborted: boolean, resetReason: string | null } | null
  failedMoves: string[]
  lastMoveError: string | null
  resetReason: string | null
  lastSearch: { status: string, tick: number } | null
  settings: { canDig: boolean, canPlace: boolean, maxDropDown: number, exclusionAreas: { step: number, break: number, place: number } }
  /** the goal's block against the step exclusion areas (excluded: their cost reaches COST_INF) */
  goalExclusion: { pos: XYZ, cost: number, excluded: boolean } | null
}

/** where the pathfinder is: its goal, its path from the current move on, the move's executor */
export function describePathState (pathfinder: ThePathfinder, goal: unknown = pathfinder.currentGoal): PathState {
  const path = pathfinder.currentPath
  const index = pathfinder.currentIndex
  const executor = pathfinder.currentExecutor as any
  const move = pathfinder.currentMove
  const cI = executor?.cI
  const settings = pathfinder.defaultMoveSettings
  let goalExclusion: PathState['goalExclusion'] = null
  const at = goalBlock(goal)
  if (at != null && settings.exclusionAreasStep.length > 0) {
    try {
      const cost = sumExclusionAreas(settings.exclusionAreasStep, pathfinder.world.getBlockInfo(at))
      goalExclusion = { pos: [at.x, at.y, at.z], cost, excluded: cost >= COST_INF }
    } catch {
      goalExclusion = null
    }
  }
  const remaining = path != null ? path.slice(index) : []
  return {
    isPathing: pathfinder.isPathing,
    goal: describeGoal(goal),
    currentIndex: index,
    remaining: remaining.slice(0, 40).map(describeMove),
    remainingTotal: remaining.length,
    currentMove: move != null ? describeMove(move) : null,
    executor: executor != null
      ? {
          type: executor.constructor?.name ?? 'MovementExecutor',
          interaction: cI != null ? { type: String(cI.type), pos: [cI.x, cI.y, cI.z], done: cI.done === true, performing: cI.isPerforming === true } : null,
          aborted: executor.aborted === true,
          resetReason: executor.resetReason?.message ?? null
        }
      : null,
    failedMoves: [...pathfinder.failedMoves],
    lastMoveError: pathfinder.lastMoveError ?? null,
    resetReason: pathfinder.resetReason ?? null,
    lastSearch: pathfinder.lastSearch ?? null,
    settings: {
      canDig: settings.canDig,
      canPlace: settings.canPlace,
      maxDropDown: settings.maxDropDown,
      exclusionAreas: { step: settings.exclusionAreasStep.length, break: settings.exclusionAreasBreak.length, place: settings.exclusionAreasPlace.length }
    },
    goalExclusion
  }
}

/** the bot's world's block at a position, as mineflayer's physics reads it */
export function worldBlockOf (bot: Bot): (pos: Vec3) => Block | null {
  return (pos: Vec3) => (bot as any).blockAt(pos, false) as Block | null
}
