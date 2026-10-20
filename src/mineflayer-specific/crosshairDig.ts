// Digging the way vanilla's player does: only the block the crosshair hits is broken (Minecraft.hitResult →
// MultiPlayerGameMode.startDestroyBlock with that block and face), so a block behind leaves, grass or another block
// isn't mined through them. mineflayer's bot.dig digs any block in reach, looked at or not (the server checks the
// distance alone), and a bot dug logs through the leaves in front of them.
import type { Bot } from 'mineflayer'
import type { Block } from 'prismarine-block'
import { Vec3 } from 'vec3'

/** the block reach: the block_interaction_range attribute from 1.20.5, else 4.5 (5 in creative) */
export function blockReach (bot: Bot): number {
  const attribute = (bot.entity as any)?.attributes?.['minecraft:block_interaction_range'] ?? (bot.entity as any)?.attributes?.['minecraft:player.block_interaction_range']
  if (typeof attribute?.value === 'number') return attribute.value
  return bot.game?.gameMode === 'creative' ? 5 : 4.5
}

function eyes (bot: Bot): Vec3 {
  return bot.entity.position.offset(0, (bot.entity as any).eyeHeight ?? 1.62, 0)
}

export interface CrosshairHit {
  block: Block
  /** the face the ray enters by (prismarine-world's BlockFace: 0 down, 1 up, 2 north, 3 south, 4 west, 5 east) */
  face: number
}

/**
 * What the crosshair hits with the bot looking as it does now: mineflayer's bot.blockAtCursor (the outline shapes
 * vanilla clips against: leaves, grass and other blocks one walks through stop it too), else the world's raycast
 */
export function crosshairBlock (bot: Bot, reach = blockReach(bot)): CrosshairHit | null {
  const hit: any = typeof (bot as any).blockAtCursor === 'function'
    ? (bot as any).blockAtCursor(reach)
    : null
  if (hit != null) return { block: hit, face: hit.face ?? 1 }
  if (typeof (bot as any).blockAtCursor === 'function') return null
  const from = eyes(bot)
  const dir = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch))
  const ray: any = bot.world.raycast(from, dir, reach)
  return ray != null ? { block: ray, face: ray.face ?? 1 } : null
}

/** the box the crosshair aims into: the block's shapes put together, a whole block when it has none */
function aimBox (block: Block): [number, number, number, number, number, number] {
  const shapes = block.shapes ?? []
  if (shapes.length === 0) return [0, 0, 0, 1, 1, 1]
  return shapes.reduce((a, s) => [Math.min(a[0], s[0]), Math.min(a[1], s[1]), Math.min(a[2], s[2]), Math.max(a[3], s[3]), Math.max(a[4], s[4]), Math.max(a[5], s[5])],
    [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]) as [number, number, number, number, number, number]
}

/** points on the faces of the block that face the eyes, the faces' centres first */
function aimPoints (block: Block, eye: Vec3): Vec3[] {
  const [x0, y0, z0, x1, y1, z1] = aimBox(block)
  const { x, y, z } = block.position
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
  const ts = [0.5, 0.2, 0.8]
  const faces: Array<{ normal: Vec3, point: (u: number, v: number) => Vec3 }> = [
    { normal: new Vec3(0, 1, 0), point: (u, v) => new Vec3(x + lerp(x0, x1, u), y + y1, z + lerp(z0, z1, v)) },
    { normal: new Vec3(0, -1, 0), point: (u, v) => new Vec3(x + lerp(x0, x1, u), y + y0, z + lerp(z0, z1, v)) },
    { normal: new Vec3(1, 0, 0), point: (u, v) => new Vec3(x + x1, y + lerp(y0, y1, u), z + lerp(z0, z1, v)) },
    { normal: new Vec3(-1, 0, 0), point: (u, v) => new Vec3(x + x0, y + lerp(y0, y1, u), z + lerp(z0, z1, v)) },
    { normal: new Vec3(0, 0, 1), point: (u, v) => new Vec3(x + lerp(x0, x1, u), y + lerp(y0, y1, v), z + z1) },
    { normal: new Vec3(0, 0, -1), point: (u, v) => new Vec3(x + lerp(x0, x1, u), y + lerp(y0, y1, v), z + z0) }
  ]
  const centre = new Vec3(x + (x0 + x1) / 2, y + (y0 + y1) / 2, z + (z0 + z1) / 2)
  const points: Vec3[] = [centre]
  for (const [u, v] of ts.flatMap(u => ts.map(v => [u, v]))) {
    for (const face of faces) {
      const p = face.point(u, v)
      if (eye.minus(p).dot(face.normal) > 0) points.push(p)
    }
  }
  return points
}

export type AimResult = { point: Vec3, face: number } | { point: null, obstruction: Block | null }

/**
 * Turns the bot toward a point of the block that the crosshair hits it at, from where it stands. When none is in
 * sight, the obstruction is what the crosshair hits on the way to the block's centre (null: nothing, out of reach).
 */
export async function aimAt (bot: Bot, block: Block, reach = blockReach(bot)): Promise<AimResult> {
  const eye = eyes(bot)
  let obstruction: Block | null = null
  let first = true
  for (const point of aimPoints(block, eye)) {
    if (point.distanceTo(eye) > reach + 0.5) continue
    await bot.lookAt(point, true)
    const hit = crosshairBlock(bot, reach)
    if (hit != null && hit.block.position.equals(block.position)) return { point, face: hit.face }
    if (first) {
      first = false
      if (hit != null) obstruction = hit.block
    }
  }
  return { point: null, obstruction }
}

export interface DigInSightOptions {
  reach?: number
  signal?: AbortSignal
  /** whether to break a block in the way first (default: one that breaks, not a fluid); false gives up on the dig */
  digObstruction?: (block: Block) => boolean
  /** blocks in the way broken at most (default 4) */
  maxObstructions?: number
  /** dig with mineflayer-mouse's left click when it is loaded (default true) */
  useMouse?: boolean
}

function broken (bot: Bot, pos: Vec3, type: number): boolean {
  const now = bot.blockAt(pos)
  return now == null || now.type !== type
}

/** a block in the way that may be broken: not a fluid, not one that never breaks, not the one the bot stands on */
function canBreak (bot: Bot, block: Block): boolean {
  if (/^(water|lava|flowing_water|flowing_lava|bubble_column)$/.test(block.name)) return false
  if (block.position.equals(bot.entity.position.offset(0, -0.5, 0).floored())) return false
  return (bot.digTime?.(block) ?? 0) !== Infinity
}

/**
 * Digs the block through the crosshair: the bot looks at a point of it in sight and digs it at the face the ray hits,
 * and stops when the crosshair goes off it (a block fell or grew into the way, the bot was turned). When none of it is
 * in sight, the block in the way is broken first, as a player breaks the leaves before the log; with nothing in the way
 * (out of reach) the dig is mineflayer's plain one. Resolves when the block is gone.
 */
export async function digInSight (bot: Bot, block: Block, options: DigInSightOptions = {}): Promise<void> {
  // (a bot with no view to aim: mineflayer's dig)
  if (typeof bot.lookAt !== 'function' || bot.entity?.position == null) return await bot.dig(block, true)
  const reach = options.reach ?? blockReach(bot)
  const pos = block.position
  const type = block.type
  const digObstruction = options.digObstruction ?? ((b: Block) => canBreak(bot, b))
  let obstructions = options.maxObstructions ?? 4
  const mouse = options.useMouse !== false && typeof (bot as any).leftClickStart === 'function' && (bot as any).mouse != null
  for (let attempt = 0; attempt < 8; attempt++) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? new Error('aborted')
    const target = bot.blockAt(pos)
    if (target == null || target.type !== type) return
    const aim = await aimAt(bot, target, reach)
    // (aborted while it turned)
    const signal: AbortSignal | undefined = options.signal
    if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
    if (aim.point == null) {
      const other = aim.obstruction
      if (other != null && !other.position.equals(pos) && obstructions > 0 && digObstruction(other)) {
        obstructions--
        await digInSight(bot, other, { ...options, maxObstructions: 0 })
        continue
      }
      // nothing in the way the crosshair finds (beyond reach, a ray through a gap), or a block not to break: the dig
      // as mineflayer does it (stopped by the signal as the crosshair's is)
      const onAbort = (): void => bot.stopDigging()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await bot.dig(target, true)
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
      return
    }
    const done = mouse ? await mouseDig(bot, target, aim.point, reach, options.signal) : await crosshairDig(bot, target, aim.point, aim.face, reach, options.signal)
    if (done || broken(bot, pos, type)) return
  }
  throw new Error(`no dig of the ${block.name} at ${pos.toString()} held the crosshair`)
}

/** the ticks a dig may take: its own, and some for the server's answer */
function digTicks (bot: Bot, block: Block): number {
  return Math.ceil((bot.digTime?.(block) ?? 0) / 50) + 100
}

/** mineflayer's dig at the face the crosshair hits, stopped when the crosshair leaves the block; true when it broke */
async function crosshairDig (bot: Bot, block: Block, point: Vec3, face: number, reach: number, signal?: AbortSignal): Promise<boolean> {
  let off = false
  const onTick = (): void => {
    const hit = crosshairBlock(bot, reach)
    if (hit == null || !hit.block.position.equals(block.position)) {
      off = true
      bot.stopDigging()
    }
  }
  const onAbort = (): void => bot.stopDigging()
  signal?.addEventListener('abort', onAbort, { once: true })
  bot.on('physicsTick', onTick)
  try {
    await bot.dig(block, 'ignore', undefined as any, face as any)
    return true
  } catch (err) {
    if (off) return false
    throw err
  } finally {
    bot.off('physicsTick', onTick)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * mineflayer-mouse's left click held on the block (it digs what the crosshair hits, its own packets and animations),
 * let go when the block breaks or the crosshair leaves it; true when it broke
 */
async function mouseDig (bot: Bot, block: Block, point: Vec3, reach: number, signal?: AbortSignal): Promise<boolean> {
  const b = bot as any
  const pos = block.position
  const limit = digTicks(bot, block)
  b.leftClickStart()
  try {
    for (let tick = 0; tick < limit; tick++) {
      await bot.waitForTicks(1)
      if (broken(bot, pos, block.type)) return true
      if (signal?.aborted === true) throw signal.reason ?? new Error('aborted')
      const cursor: Block | null = b.mouse.getCursorState?.().cursorBlock ?? crosshairBlock(bot, reach)?.block ?? null
      if (cursor == null || !cursor.position.equals(pos)) return false
    }
    throw new Error(`the dig of the ${block.name} at ${pos.toString()} took over ${limit} ticks`)
  } finally {
    b.leftClickEnd()
  }
}

/** prismarine-world's BlockFace number as the face's direction (0 down, 1 up, 2 north, 3 south, 4 west, 5 east) */
function faceVector (face: number): Vec3 {
  return [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)][face] ?? new Vec3(0, 1, 0)
}

export interface UseInSightOptions {
  reach?: number
  /** use with mineflayer-mouse's right click when it is loaded (default true) */
  useMouse?: boolean
}

/**
 * A right click on the block through the crosshair, as vanilla's use (Minecraft.startUseItem: useItemOn with the
 * crosshair's block, face and point): the bot looks at a point of the block in sight, then mineflayer-mouse's right
 * click when it is loaded (its packets, both hands as vanilla tries them), else mineflayer's activateBlock with that
 * face and point. False when no point of the block is in sight from here: nothing is sent.
 */
export async function useInSight (bot: Bot, block: Block, options: UseInSightOptions = {}): Promise<boolean> {
  const reach = options.reach ?? blockReach(bot)
  const aim = await aimAt(bot, block, reach)
  if (aim.point == null) return false
  const b = bot as any
  if (options.useMouse !== false && typeof b.rightClick === 'function' && b.mouse != null) {
    b.rightClick()
    return true
  }
  await b.activateBlock(block, faceVector(aim.face), aim.point.minus(block.position))
  return true
}
