import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { MovementOptions } from './movements'

// A search's costs round what the bot would rather keep away from, and toward the path it walked before (the ideas of
// Baritone's Avoidance and Favoring, re-implemented): a move ending within mobAvoidanceRadius of a hostile mob costs
// mobAvoidanceCoefficient times as much (each such mob once more), within spawnerAvoidanceRadius of a spawner
// spawnerAvoidanceCoefficient times; a move ending on a cell of the path the goto walked last backtrackFavoringCoefficient
// times (a search again after a reset keeps to the way it had, not a new one as cheap). Taken when a search starts.

/** a sphere round a point that the moves ending in it cost `coefficient` times as much */
export interface Avoidance {
  pos: Vec3
  radius: number
  coefficient: number
}

/** hostile mobs mineflayer's entity data doesn't type 'hostile' in every version */
const HOSTILE_NAMES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton', 'creeper', 'spider',
  'cave_spider', 'enderman', 'endermite', 'silverfish', 'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'phantom',
  'guardian', 'elder_guardian', 'shulker', 'vex', 'vindicator', 'evoker', 'pillager', 'ravager', 'illusioner', 'hoglin',
  'zoglin', 'piglin', 'piglin_brute', 'zombified_piglin', 'warden', 'breeze', 'creaking'
])

/** the light a mob's brain sees at its feet: the block's light, or the sky's as the time of day leaves it */
function lightAt (bot: Bot, pos: Vec3): number {
  const block = bot.blockAt(pos.floored()) as any
  if (block == null) return 15
  const sky: number = typeof block.skyLight === 'number' ? block.skyLight : 15
  const own: number = typeof block.light === 'number' ? block.light : 0
  // night darkens the sky's light by up to 11 (Level.updateSkyBrightness's skyDarken)
  const day = (bot.time as any)?.isDay !== false
  return Math.max(own, sky - (day ? 0 : 11))
}

function metadataFlag (entity: any, ...keys: string[]): boolean {
  const meta = entity?.metadata
  if (meta == null) return false
  for (const key of keys) {
    const v = (meta as any)[key]
    if (v === true) return true
  }
  return false
}

/**
 * Whether a mob is one to keep away from: hostile, but a spider only in the dark (Spider's attack goal: brightness
 * under 0.5), a zombified piglin only angry, an enderman only provoked (EnderMan.isCreepy), as Baritone's filters
 */
export function isAvoidedMob (bot: Bot, entity: any): boolean {
  if (entity == null || entity === bot.entity) return false
  const name: string = entity.name ?? ''
  const hostile = entity.type === 'hostile' || HOSTILE_NAMES.has(name)
  if (!hostile) return false
  if (entity.isValid === false) return false
  if (name === 'spider' || name === 'cave_spider') return lightAt(bot, entity.position) <= 7
  // (mineflayer's names of the metadata: Mob's aggressive flag, EnderMan's DATA_CREEPY)
  if (name === 'zombified_piglin') return metadataFlag(entity, 'aggressive', 'angry', 'isAggressive')
  if (name === 'enderman') return metadataFlag(entity, 'creepy', 'screaming', 'isCreepy')
  return true
}

/** how far a spawner's block is looked for when a search starts */
const SPAWNER_SEARCH = 48

/** the avoidances a search starts with: the hostile mobs about and the spawners near, by the movement settings */
export function collectAvoidances (bot: Bot, settings: MovementOptions): Avoidance[] {
  const out: Avoidance[] = []
  if (!settings.avoidance || bot.entity == null) return out
  const mobCoef = settings.mobAvoidanceCoefficient
  if (mobCoef !== 1) {
    for (const e of Object.values(bot.entities ?? {})) {
      if (!isAvoidedMob(bot, e)) continue
      out.push({ pos: (e as any).position.floored(), radius: settings.mobAvoidanceRadius, coefficient: mobCoef })
    }
  }
  const spawnerCoef = settings.spawnerAvoidanceCoefficient
  if (spawnerCoef !== 1 && typeof (bot as any).findBlocks === 'function') {
    const ids = ['spawner', 'mob_spawner'].map(n => bot.registry.blocksByName[n]?.id).filter((id): id is number => id != null)
    if (ids.length > 0) {
      let found: Vec3[] = []
      try {
        found = bot.findBlocks({ matching: ids, maxDistance: SPAWNER_SEARCH, count: 16 })
      } catch {}
      for (const pos of found) out.push({ pos, radius: settings.spawnerAvoidanceRadius, coefficient: spawnerCoef })
    }
  }
  return out
}

/**
 * The factor a move ending in the cell (x, y, z) costs: each avoidance's coefficient whose sphere has it, and the
 * favoring's on a cell of the path walked before
 */
export function cellCostFactor (avoidances: Avoidance[], favored: ReadonlySet<string> | undefined, favorCoef: number, x: number, y: number, z: number): number {
  let f = 1
  for (const a of avoidances) {
    const dx = x - a.pos.x
    const dy = y - a.pos.y
    const dz = z - a.pos.z
    if (dx * dx + dy * dy + dz * dz <= a.radius * a.radius) f *= a.coefficient
  }
  if (favored != null && favorCoef !== 1 && favored.has(`${x},${y},${z}`)) f *= favorCoef
  return f
}

/** the cells (floored, as keys) of a path's moves' ends */
export function pathCells (path: Array<{ exitPos: Vec3 }>): Set<string> {
  const cells = new Set<string>()
  for (const m of path) cells.add(`${Math.floor(m.exitPos.x)},${Math.floor(m.exitPos.y + 1e-6)},${Math.floor(m.exitPos.z)}`)
  return cells
}
