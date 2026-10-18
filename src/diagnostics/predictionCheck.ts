/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { BotcraftPhysics, ControlStateHandler, EPhysicsCtx, PlayerState } from '@nxg-org/mineflayer-physics-util'
import type { Block } from '../types'
import { RingBuffer } from './ringBuffer'

/**
 * Why the bot's tick didn't go as the physics predicted. mineflayer's own physics is physics-util's engine, so a
 * mismatch is something outside the model:
 * - server_correction: a position packet moved the bot (mineflayer's forcedMove)
 * - velocity: an entity_velocity packet for the bot (a knockback)
 * - explosion: an explosion's knockback
 * - block_change: a block near the bot changed since the last tick (the prediction ran on the world as it was)
 * - own_block_change: the same, a block the bot itself dug or placed (expected)
 * - cache_stale: the pathfinder's cached world differs from the bot's (the prediction ran on the cache)
 * - entity_push: none of those, with an entity close enough to push
 * - unknown: none of those
 */
export type MismatchClass = 'server_correction' | 'velocity' | 'explosion' | 'block_change' | 'own_block_change' | 'cache_stale' | 'entity_push' | 'unknown'

/** the classes that don't point at a fault (the bot's own digs and places) */
export const EXPECTED_MISMATCHES: ReadonlySet<MismatchClass> = new Set(['own_block_change'])

export type XYZ = [number, number, number]

export interface TickSample {
  /** the client tick (PredictionCheck.tick) */
  tick: number
  pos: XYZ
  vel: XYZ
  onGround: boolean
  /** the keys held this tick: 'forward+sprint+jump', '' for none */
  controls: string
  yaw: number
  pitch: number
  /** how far the bot ended from the predicted position (null when the tick wasn't checked) */
  delta: number | null
  /** how far its velocity was from the predicted one */
  velDelta: number | null
  /** set when the tick was a mismatch */
  mismatch?: MismatchClass
  /** the block being dug, the executor's interaction */
  dig?: XYZ
  collided?: boolean
}

export interface DiagEvent {
  tick: number
  type: string
  [key: string]: unknown
}

export interface Mismatch {
  tick: number
  cls: MismatchClass
  delta: number
  velDelta: number
  predicted: { pos: XYZ, vel: XYZ, onGround: boolean }
  actual: { pos: XYZ, vel: XYZ, onGround: boolean }
  /** the blocks changed near the bot since the last tick */
  changed?: Array<{ pos: XYZ, from: string, to: string, own: boolean }>
}

/** what's known about a mismatched tick, for classifyMismatch */
export interface MismatchEvidence {
  forcedMove: boolean
  velocityPacket: boolean
  explosion: boolean
  /** blocks near the bot changed since the last tick; own: the bot's dig or place */
  changedBlocks: Array<{ own: boolean }>
  /** a prediction on the world as it is now (the change in) matched: null when not tried */
  matchesWithChanges: boolean | null
  /** a prediction on the bot's world (not the pathfinder's cache) matched: null when not tried */
  matchesBotWorld: boolean | null
  /** entities within pushing distance */
  entitiesNear: number
}

/** the class of a mismatch, the first cause the evidence shows (packets, then blocks, then the cache, then entities) */
export function classifyMismatch (e: MismatchEvidence): MismatchClass {
  if (e.forcedMove) return 'server_correction'
  if (e.explosion) return 'explosion'
  if (e.velocityPacket) return 'velocity'
  if (e.changedBlocks.length > 0 && e.matchesWithChanges === true) {
    return e.changedBlocks.every((c) => c.own) ? 'own_block_change' : 'block_change'
  }
  if (e.matchesBotWorld === true) return 'cache_stale'
  if (e.entitiesNear > 0) return 'entity_push'
  return 'unknown'
}

export interface SimWorld {
  getBlock: (pos: Vec3) => Block | null
}

export interface PredictionCheckOptions {
  /** the world the prediction runs on: the pathfinder's cache (default bot.physicsWorld, mineflayer's own) */
  world?: () => SimWorld
  /** the executor's current interaction (a dig or a place), sampled each tick */
  interaction?: () => { type: string, pos: Vec3 } | undefined
  /** ticks of samples kept (default 100) */
  samples?: number
  /** events kept (default 200) */
  events?: number
  /** how far off (blocks, blocks a tick) a tick may end before it's a mismatch (default 1e-5) */
  tolerance?: number
  /** blocks this near the bot (Chebyshev, from its feet) are watched for changes (default 3) */
  nearRadius?: number
}

function xyz (v: { x: number, y: number, z: number }): XYZ {
  return [v.x, v.y, v.z]
}

function key (x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** a dig's face: mineflayer's targetDigFace is prismarine-world's BlockFace number (0 bottom, 1 top, 2 north ...) */
const DIG_FACES = ['bottom', 'top', 'north', 'south', 'west', 'east']
function digFace (face: unknown): string | XYZ | null {
  if (typeof face === 'number') return DIG_FACES[face] ?? String(face)
  if (face instanceof Vec3) return xyz(face)
  return null
}

const CONTROL_NAMES = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const

export function controlsString (c: { [K in typeof CONTROL_NAMES[number]]: boolean }): string {
  let out = ''
  for (const name of CONTROL_NAMES) {
    if (c[name]) out = out === '' ? name : `${out}+${name}`
  }
  return out
}

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now()

/**
 * Checks each of the bot's physics ticks against physics-util's prediction, and keeps what the last ticks did (a
 * sample a tick, and the events around them: position corrections, knockbacks, block changes near the bot, digs,
 * interactions, damage), for a stuck report.
 *
 * Each tick it is on, it runs one tick of the engine from the bot's state at the end of the tick before (before the
 * server's packets in between), with the keys and the rotation the bot's tick used, on the pathfinder's world as it
 * was then, and compares the bot's position, velocity and onGround after its tick with the prediction. A mismatch is
 * simulated again (on the world as it is, then on the bot's own world) to tell a block change from a stale cache, and
 * classified (classifyMismatch). It's on while a path is executing (acquire) or always (alwaysOn).
 */
export class PredictionCheck {
  readonly samples: RingBuffer<TickSample>
  readonly events: RingBuffer<DiagEvent>
  readonly mismatches = new RingBuffer<Mismatch>(50)
  /** client ticks seen since the check was made */
  tick = 0
  /** on even with no path executing */
  alwaysOn = false
  /** run the prediction (one engine tick a tick, about 0.2 - 0.5 ms); false keeps only the samples and the events */
  predict = true
  /** the first tick of the current run of mismatches that aren't expected ones (null when the last tick matched) */
  mismatchSince: number | null = null
  mismatchSinceClass: MismatchClass | null = null
  /** what the check cost: the ticks seen and checked, and the time its tick handlers took (ms in all, the most in one) */
  readonly stats = { ticks: 0, checked: 0, mismatched: 0, resimulated: 0, ms: 0, maxMs: 0 }

  private holders = 0
  private readonly tolerance: number
  private readonly nearRadius: number
  private engine?: BotcraftPhysics
  private ctx?: EPhysicsCtx<PlayerState>
  private spare?: EPhysicsCtx<PlayerState>
  /** the bot's state at the end of the last tick */
  private saved: { pos: Vec3, vel: Vec3, onGround: boolean } | null = null
  /** the tick began with the state reset to `saved` */
  private pending = false
  /** blocks changed near the bot since the last tick: their state before */
  private readonly overlay = new Map<string, { old: Block | null, name: string, pos: Vec3, own: boolean }>()
  private forcedMove = false
  private velocityPacket = false
  private explosion = false
  private lastDig: string | null = null
  private lastInteraction: string | null = null
  /** the bot's own digs and places lately, by position: the tick each was seen */
  private readonly own = new Map<string, number>()
  private lastHealth: number | undefined
  /** the keys of the last tick, on or off (for prevControl where the bot's engine doesn't show its own) */
  private lastControls: ControlStateHandler | null = null
  private readonly disposers: Array<() => void> = []

  constructor (private readonly bot: Bot, private readonly opts: PredictionCheckOptions = {}) {
    this.samples = new RingBuffer(opts.samples ?? 100)
    this.events = new RingBuffer(opts.events ?? 200)
    this.tolerance = opts.tolerance ?? 1e-5
    this.nearRadius = opts.nearRadius ?? 3
    this.listen()
  }

  /** whether ticks are checked and recorded now */
  get enabled (): boolean {
    return this.alwaysOn || this.holders > 0
  }

  /** turns the check on until the returned release is called (the executor, while a path executes) */
  acquire (): () => void {
    this.holders++
    let released = false
    return () => {
      if (released) return
      released = true
      this.holders--
    }
  }

  /** an event of the caller's (a skill's), kept with the check's own */
  recordEvent (type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ tick: this.tick, type, ...data })
  }

  /** a block the bot itself changes (a dig, a place): its change isn't a fault */
  noteOwnChange (pos: Vec3): void {
    this.own.set(key(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), this.tick)
  }

  /** the events of the last `ticks` ticks */
  recentEvents (ticks = this.samples.capacity): DiagEvent[] {
    return this.events.toArray().filter((e) => e.tick > this.tick - ticks)
  }

  detach (): void {
    for (const dispose of this.disposers.splice(0)) dispose()
  }

  private on (emitter: any, event: string, listener: (...args: any[]) => void, prepend = false): void {
    if (emitter == null || typeof emitter.on !== 'function') return
    if (prepend && typeof emitter.prependListener === 'function') emitter.prependListener(event, listener)
    else emitter.on(event, listener)
    this.disposers.push(() => emitter.removeListener(event, listener))
  }

  private listen (): void {
    const bot = this.bot
    // first of the tick's listeners: the keys and the look are still those the bot's tick ran with
    this.on(bot, 'physicsTick', () => this.onTickEnd(), true)
    this.on(bot, 'physicsTickBegin', () => this.onTickBegin())
    this.on(bot, 'forcedMove', () => {
      if (!this.enabled) return
      this.forcedMove = true
      const from = this.saved?.pos
      this.recordEvent('position_correction', { from: from != null ? xyz(from) : null, to: xyz(bot.entity.position) })
    })
    this.on(bot._client, 'entity_velocity', (packet: any) => {
      if (!this.enabled || packet?.entityId !== bot.entity?.id) return
      this.velocityPacket = true
      const v = packet.velocity ?? { x: packet.velocityX, y: packet.velocityY, z: packet.velocityZ }
      this.recordEvent('velocity', { velocity: v != null ? [v.x, v.y, v.z] : null })
    })
    this.on(bot._client, 'explosion', (packet: any) => {
      if (!this.enabled) return
      const k = packet?.playerKnockback ?? (packet?.playerMotionX != null ? { x: packet.playerMotionX, y: packet.playerMotionY, z: packet.playerMotionZ } : null)
      if (k == null || (k.x === 0 && k.y === 0 && k.z === 0)) return
      this.explosion = true
      this.recordEvent('explosion', { knockback: [k.x, k.y, k.z] })
    })
    this.on(bot, 'blockUpdate', (oldBlock: Block | null, newBlock: Block | null) => this.onBlockUpdate(oldBlock, newBlock))
    this.on(bot, 'health', () => {
      const health = bot.health
      if (this.enabled && this.lastHealth != null && health < this.lastHealth) {
        this.recordEvent('damage', { amount: this.lastHealth - health, health })
      }
      this.lastHealth = health
    })
  }

  private onBlockUpdate (oldBlock: Block | null, newBlock: Block | null): void {
    if (!this.enabled) return
    const at = newBlock?.position ?? oldBlock?.position
    const feet = this.bot.entity?.position
    if (at == null || feet == null) return
    const r = this.nearRadius
    if (Math.abs(at.x + 0.5 - feet.x) > r + 0.5 || Math.abs(at.y - feet.y) > r + 1 || Math.abs(at.z + 0.5 - feet.z) > r + 0.5) return
    const k = key(at.x, at.y, at.z)
    if ((oldBlock?.stateId ?? -1) === (newBlock?.stateId ?? -1)) return
    const own = this.isOwn(k)
    // the first state since the last tick is the one the prediction runs on
    if (!this.overlay.has(k)) this.overlay.set(k, { old: oldBlock, name: newBlock?.name ?? 'unknown', pos: at.clone(), own })
    this.recordEvent('block_update', { pos: xyz(at), from: oldBlock?.name ?? null, to: newBlock?.name ?? null, own })
  }

  private isOwn (k: string): boolean {
    const seen = this.own.get(k)
    return seen != null && this.tick - seen <= 40
  }

  private eligible (): boolean {
    const bot = this.bot as any
    if (bot.entity == null || bot.entity.vehicle != null) return false
    if (bot.physicsEnabled === false || bot.isSleeping === true) return false
    if (bot.health != null && bot.health <= 0) return false
    return true
  }

  private ensureCtx (): EPhysicsCtx<PlayerState> {
    if (this.ctx != null) return this.ctx
    const bot = this.bot as any
    this.engine = new BotcraftPhysics(bot.registry)
    // the bot's physics' settings (mineflayer's physics plugin): the same engine, set up the same
    this.ctx = EPhysicsCtx.FROM_BOT(this.engine, bot, bot.physicsSettings) as EPhysicsCtx<PlayerState>
    this.spare = EPhysicsCtx.FROM_BOT(this.engine, bot, bot.physicsSettings) as EPhysicsCtx<PlayerState>
    if (bot.physicsSettings?.overrides != null) {
      Object.assign(this.ctx, bot.physicsSettings.overrides)
      Object.assign(this.spare, bot.physicsSettings.overrides)
    }
    return this.ctx
  }

  private baseWorld (): SimWorld {
    const bot = this.bot as any
    return this.opts.world?.() ?? bot.physicsWorld ?? { getBlock: (pos: Vec3) => bot.blockAt(pos, false) }
  }

  private botWorld (): SimWorld {
    const bot = this.bot as any
    return bot.physicsWorld ?? { getBlock: (pos: Vec3) => bot.blockAt(pos, false) }
  }

  /** the world as it was at the end of the last tick: the base world with the blocks changed since put back */
  private worldBefore (base: SimWorld): SimWorld {
    if (this.overlay.size === 0) return base
    const overlay = this.overlay
    return {
      getBlock: (pos: Vec3) => {
        const entry = overlay.get(key(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)))
        return entry != null ? entry.old : base.getBlock(pos)
      }
    }
  }

  private onTickBegin (): void {
    this.pending = false
    if (!this.enabled || !this.predict || this.saved == null || !this.eligible()) return
    const t0 = now()
    const ctx = this.ensureCtx()
    // as mineflayer's tick: the state from the bot (its effects, its entities about it, ...), then the position, the
    // velocity and onGround it had at the end of the last tick, before any packet since
    ctx.state.update(this.bot)
    ctx.state.pos.set(this.saved.pos.x, this.saved.pos.y, this.saved.pos.z)
    ctx.state.vel.set(this.saved.vel.x, this.saved.vel.y, this.saved.vel.z)
    ctx.state.onGround = this.saved.onGround
    // the keys of the tick before as the bot's engine kept them (its prevControl: the sneak key the crouch follows,
    // LocalPlayer.aiStep, and the jump key a glide waits on), which update() leaves to the state's own last tick: the
    // check's was the last tick it checked, and on again after a while off, a sneak let go of ticks ago crouched the
    // prediction, kept it from sprinting, and the tick was an 'unknown' mismatch (0.289 off, a sprint jump)
    const prev = (this.bot.entity as { prevControl?: ControlStateHandler }).prevControl
    if (prev != null && typeof prev.clone === 'function') ctx.state.prevControl = prev.clone()
    else if (this.lastControls != null) ctx.state.prevControl = this.lastControls.clone()
    this.pending = true
    this.stats.ms += now() - t0
  }

  private onTickEnd (): void {
    this.tick++
    if (this.bot.entity != null) this.lastControls = ControlStateHandler.COPY_BOT(this.bot)
    if (!this.enabled) {
      this.reset()
      return
    }
    const t0 = now()
    const bot = this.bot
    const entity = bot.entity
    if (entity == null) return
    this.stats.ticks++

    const controls = ControlStateHandler.COPY_BOT(bot)
    const sample: TickSample = {
      tick: this.tick,
      pos: xyz(entity.position),
      vel: xyz(entity.velocity),
      onGround: entity.onGround,
      controls: controlsString(controls),
      yaw: entity.yaw,
      pitch: entity.pitch,
      delta: null,
      velDelta: null
    }
    if ((entity as any).isCollidedHorizontally === true) sample.collided = true
    this.sampleInteractions(sample)

    if (this.pending && this.predict && this.eligible()) {
      this.check(controls, sample)
    }

    this.samples.push(sample)
    this.saved = { pos: entity.position.clone(), vel: entity.velocity.clone(), onGround: entity.onGround }
    this.overlay.clear()
    this.forcedMove = false
    this.velocityPacket = false
    this.explosion = false
    this.pending = false
    const ms = now() - t0
    this.stats.ms += ms
    if (ms > this.stats.maxMs) this.stats.maxMs = ms
  }

  private reset (): void {
    this.saved = null
    this.pending = false
    this.overlay.clear()
    this.forcedMove = false
    this.velocityPacket = false
    this.explosion = false
    this.mismatchSince = null
    this.mismatchSinceClass = null
  }

  private sampleInteractions (sample: TickSample): void {
    const bot = this.bot as any
    const dig = bot.targetDigBlock?.position as Vec3 | undefined
    const digKey = dig != null ? key(dig.x, dig.y, dig.z) : null
    if (dig != null) {
      sample.dig = xyz(dig)
      this.noteOwnChange(dig)
    }
    if (digKey !== this.lastDig) {
      if (this.lastDig != null) this.recordEvent('dig_end', { pos: this.lastDig.split(',').map(Number) })
      if (dig != null) this.recordEvent('dig_start', { pos: xyz(dig), block: bot.targetDigBlock?.name ?? null, face: digFace(bot.targetDigFace) })
      this.lastDig = digKey
    }
    const interaction = this.opts.interaction?.()
    const iKey = interaction != null ? `${interaction.type}@${key(interaction.pos.x, interaction.pos.y, interaction.pos.z)}` : null
    if (interaction != null) this.noteOwnChange(interaction.pos)
    if (iKey !== this.lastInteraction) {
      if (this.lastInteraction != null) this.recordEvent('interaction_end', { what: this.lastInteraction })
      if (interaction != null) this.recordEvent('interaction_start', { kind: interaction.type, pos: xyz(interaction.pos) })
      this.lastInteraction = iKey
    }
  }

  private simulate (ctx: EPhysicsCtx<PlayerState>, world: SimWorld): void {
    (this.engine as BotcraftPhysics).simulate(ctx, world as any)
  }

  private matches (state: PlayerState): { ok: boolean, delta: number, velDelta: number } {
    const entity = this.bot.entity
    const delta = state.pos.distanceTo(entity.position)
    const velDelta = state.vel.distanceTo(entity.velocity)
    const ok = delta <= this.tolerance && velDelta <= this.tolerance && state.onGround === entity.onGround
    return { ok, delta, velDelta }
  }

  private check (controls: ControlStateHandler, sample: TickSample): void {
    const ctx = this.ensureCtx()
    const spare = this.spare as EPhysicsCtx<PlayerState>
    const entity = this.bot.entity
    // the keys and the look this tick ran with (the bot's tick restores its target look after the move)
    ctx.state.control = controls
    ctx.state.yaw = entity.yaw
    ctx.state.pitch = entity.pitch
    const yawDegrees = (entity as { yawDegrees?: unknown }).yawDegrees
    ctx.state.yawDegrees = yawDegrees == null ? undefined : Number(yawDegrees)
    spare.state.merge(ctx.state)

    const base = this.baseWorld()
    this.simulate(ctx, this.worldBefore(base))
    this.stats.checked++
    const first = this.matches(ctx.state)
    sample.delta = first.delta
    sample.velDelta = first.velDelta
    if (first.ok) {
      this.mismatchSince = null
      this.mismatchSinceClass = null
      return
    }

    this.stats.mismatched++
    const predicted = { pos: xyz(ctx.state.pos), vel: xyz(ctx.state.vel), onGround: ctx.state.onGround }
    const changed = [...this.overlay.values()]
    const evidence: MismatchEvidence = {
      forcedMove: this.forcedMove,
      velocityPacket: this.velocityPacket,
      explosion: this.explosion,
      changedBlocks: changed,
      matchesWithChanges: null,
      matchesBotWorld: null,
      entitiesNear: this.entitiesNear()
    }
    if (!evidence.forcedMove && !evidence.velocityPacket && !evidence.explosion) {
      // the same tick on the world as it is now: a match puts it down to the blocks changed
      if (changed.length > 0) {
        ctx.state.merge(spare.state)
        this.simulate(ctx, base)
        this.stats.resimulated++
        evidence.matchesWithChanges = this.matches(ctx.state).ok
      }
      // on the bot's own world: a match puts it down to the pathfinder's cache
      if (evidence.matchesWithChanges !== true && this.opts.world != null) {
        ctx.state.merge(spare.state)
        this.simulate(ctx, this.botWorld())
        this.stats.resimulated++
        evidence.matchesBotWorld = this.matches(ctx.state).ok
      }
    }
    const cls = classifyMismatch(evidence)
    sample.mismatch = cls
    this.mismatches.push({
      tick: this.tick,
      cls,
      delta: first.delta,
      velDelta: first.velDelta,
      predicted,
      actual: { pos: xyz(entity.position), vel: xyz(entity.velocity), onGround: entity.onGround },
      changed: changed.length > 0 ? changed.map((c) => ({ pos: xyz(c.pos), from: c.old?.name ?? 'unknown', to: c.name, own: c.own })) : undefined
    })
    this.recordEvent('prediction_mismatch', { cls, delta: first.delta, velDelta: first.velDelta })
    if (EXPECTED_MISMATCHES.has(cls)) return
    if (this.mismatchSince == null) {
      this.mismatchSince = this.tick
      this.mismatchSinceClass = cls
    }
  }

  private entitiesNear (): number {
    const bot = this.bot
    const pos = bot.entity.position
    let n = 0
    for (const entity of Object.values(bot.entities ?? {})) {
      if (entity === bot.entity || entity?.position == null) continue
      const dx = entity.position.x - pos.x
      const dz = entity.position.z - pos.z
      const dy = entity.position.y - pos.y
      if (Math.abs(dy) < 2.5 && dx * dx + dz * dz < 2.25) n++
    }
    return n
  }
}
