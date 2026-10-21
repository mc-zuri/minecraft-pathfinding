import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { BotcraftPhysics, ControlStateHandler, EPhysicsCtx, PlayerState } from '@nxg-org/mineflayer-physics-util'

// The last line against a walk off a ledge: whenever the bot's keys would take its feet off the ground this tick over a
// drop deeper than it may fall (no move planning it), it sneaks, as vanilla's sneak at an edge holds a player
// (Player.maybeBackOffFromEdge: on the ground with the shift key down, a move that would leave the ground by more than
// the step height is cut back to the edge), and lets go of jump and sprint. Whatever ran the bot to the edge (a move's
// momentum past its end, a failed move's slide, a merged line across a ledge, a jump, a skill's own steering) is caught
// before the physics tick moves the bot. Its next tick is physics-util's simulation, the engine mineflayer's own
// physics runs, of the keys as they are; a fall that's on its way is followed down to where it lands.

/** a fall the bot's keys would start this tick */
export interface EdgeFall {
  /** blocks from the bot's feet down to where it would land; Infinity with no ground under it (the void) */
  depth: number
  /** the most the bot may drop there */
  allowed: number
  /** where the bot's feet are */
  from: Vec3
  /** where its feet would be once it left the ground */
  over: Vec3
  /** a jump (the jump key) took it off the ground, not a walk off the edge */
  jump: boolean
  /** it would land in lava */
  lava: boolean
}

export interface EdgeGuardOptions {
  /** the most the bot may drop now (the pathfinder's: maxDropDown, or the drop the current move plans) */
  allowedDrop: () => number
  /** the world the physics runs on (default the bot's physics world) */
  world?: () => any
  /** whether a walk's fall is followed with its keys held on too (predictEdgeFall's keysHeld; default always) */
  keysHeld?: () => boolean
}

/** a drop this much over the allowed one is one (a float's rounding) */
const DEPTH_EPSILON = 0.05
/** ticks a jump is followed to its landing, at most */
const MAX_JUMP_TICKS = 30
/** ticks a fall is followed before the column under it is looked down instead */
const MAX_FALL_TICKS = 30
/** blocks the column under a fall is looked down, at most (the void: none) */
const MAX_SCAN = 384
/** horizontal speed under which a bot with no movement key down can't go anywhere this tick */
const STILL_SPEED = 1e-3

const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding', 'twisting_vines', 'twisting_vines_plant', 'weeping_vines', 'weeping_vines_plant', 'cave_vines', 'cave_vines_plant'])
/** a portal takes the bot elsewhere as it falls in (the stronghold's end portal over its lava, the End's exit) */
const PORTALS = new Set(['end_portal', 'end_gateway', 'nether_portal'])
const SOFT_LANDING = new Set(['water', 'bubble_column', 'cobweb', 'powder_snow', ...CLIMBABLE, ...PORTALS])

function isWaterlogged (block: any): boolean {
  try {
    return block?.getProperties?.()?.waterlogged === true
  } catch {
    return false
  }
}

/** the top of a block's collision boxes over its cell's floor (0 for none) */
function shapeTop (block: any): number {
  if (block == null || block.boundingBox !== 'block') return 0
  const shapes: number[][] | undefined = block.shapes
  if (shapes == null || shapes.length === 0) return 1
  let top = 0
  for (const s of shapes) top = Math.max(top, s[4])
  return top
}

/**
 * Where a fall from `feetY` of a box spanning [minX, maxX] x [minZ, maxZ] lands: the highest top under it of any column
 * the box is over, and what it is. null when a column runs into the world's unloaded part (nothing to say).
 */
export function landingUnder (world: { getBlock: (pos: Vec3) => any }, minX: number, maxX: number, minZ: number, maxZ: number, feetY: number, minY = -64): { y: number, soft: boolean, lava: boolean } | null {
  let best: { y: number, soft: boolean, lava: boolean } = { y: -Infinity, soft: false, lava: false }
  const startY = Math.floor(feetY + 1e-6)
  for (let x = Math.floor(minX); x <= Math.floor(maxX - 1e-7); x++) {
    for (let z = Math.floor(minZ); z <= Math.floor(maxZ - 1e-7); z++) {
      for (let y = startY, n = 0; y >= minY && n < MAX_SCAN; y--, n++) {
        if (y + 1 <= best.y) break
        const block = world.getBlock(new Vec3(x, y, z))
        if (block == null) return null
        const name: string = block.name
        if (SOFT_LANDING.has(name) || isWaterlogged(block)) {
          if (y + 1 > best.y) best = { y: y + 1, soft: true, lava: false }
          break
        }
        if (name === 'lava') {
          if (y + 1 > best.y) best = { y: y + 1, soft: false, lava: true }
          break
        }
        const top = shapeTop(block)
        if (top > 0) {
          // a block at the box's own height is a wall it falls beside (the physics kept it out), no ground under it
          if (y + top > feetY + 1e-6) break
          if (y + top > best.y) best = { y: y + top, soft: false, lava: false }
          break
        }
      }
    }
  }
  return best
}

/**
 * Whether the bot moves on its own keys on foot now, where a step off an edge is the walk's: not riding, gliding,
 * flying, swimming, climbing, in a web, falling slowly, levitating, in creative or spectator, or dead
 */
export function onFootOnGround (bot: Bot): boolean {
  const e = bot.entity as any
  if (e == null || (bot as any).physicsEnabled === false) return false
  if (e.vehicle != null || (bot as any).vehicle != null) return false
  if (bot.health != null && bot.health <= 0) return false
  if (e.onGround !== true) return false
  if (e.isInWater === true || e.isInLava === true || e.onClimbable === true || e.isInWeb === true) return false
  if (e.fallFlying === true || e.elytraFlying === true || e.flying === true) return false
  const mode = bot.game?.gameMode
  return mode !== 'creative' && mode !== 'spectator'
}

/** the step height a sneak's hold looks down (maxUpStep: the player's step height) */
const STEP_HEIGHT = 0.6

/** whether the state's box has no ground within the step height under it (worldIsFree of the box moved down) */
function overEdge (engine: BotcraftPhysics, world: any, state: PlayerState): boolean {
  const bb = state.getBB().translate(0, -STEP_HEIGHT, 0)
  bb.expand(-1e-7, -1e-7, -1e-7)
  return (engine as any).worldIsFree(world, bb, true) === true
}

/** a key that moves the bot (or jumps it) is down */
function movesOnKeys (controls: ControlStateHandler): boolean {
  return controls.forward || controls.back || controls.left || controls.right || controls.jump
}

/**
 * Predicts whether the bot's keys (`controls`, default the ones down now) take it off the ground this tick over a drop
 * deeper than `allowed`: its next tick simulated, and from there the fall or the jump followed to where it lands (or,
 * past the allowed depth, the column under it looked down: water, a ladder or a web under a deep fall is no harm).
 * null when the bot stays on the ground, isn't on its feet on the ground now (onFootOnGround), or lands no deeper.
 */
export function predictEdgeFall (bot: Bot, allowed: number, opts: { controls?: ControlStateHandler, world?: any, engine?: BotcraftPhysics, keysHeld?: boolean } = {}): EdgeFall | null {
  if (!onFootOnGround(bot)) return null
  const controls = opts.controls ?? ControlStateHandler.COPY_BOT(bot)
  const e = bot.entity
  if (!movesOnKeys(controls) && Math.hypot(e.velocity.x, e.velocity.z) < STILL_SPEED) return null
  const engine = opts.engine ?? new BotcraftPhysics(bot.registry)
  // A jump is followed with its keys held; a walk off the edge with the keys let go, and with `keysHeld` (default
  // true) with them held on too (the steering that ran the bot off holds them: a chase's forward and sprint carry the
  // fall on through the air), the worse of the two. Followed with the keys let go only, a sprint off a step of 2 down a
  // slope was a fall onto the next step, while the keys held carried the bot two steps down, onto the brink of a
  // sinkhole and into it: a 26.3 bot chasing a cow fell 49 blocks (f1-26.3, t8914). (A goto's moves steer the fall
  // they plan, a drop onto a lane a block wide, and keysHeld is off for them: EdgeGuardOptions.keysHeld.)
  if (controls.jump) return followEdgeFall(bot, allowed, controls, true, engine, opts.world)
  const released = followEdgeFall(bot, allowed, controls, false, engine, opts.world)
  if (opts.keysHeld === false || !movesOnKeys(controls)) return released
  const held = followEdgeFall(bot, allowed, controls, true, engine, opts.world)
  if (released == null) return held
  if (held == null) return released
  return held.lava || (!released.lava && held.depth > released.depth) ? held : released
}

/** predictEdgeFall's fall, from the bot's next tick on its `controls`, followed with them held on or let go */
function followEdgeFall (bot: Bot, allowed: number, controls: ControlStateHandler, holdKeys: boolean, engine: BotcraftPhysics, worldOpt?: any): EdgeFall | null {
  const e = bot.entity
  const ctx = EPhysicsCtx.FROM_BOT(engine, bot, (bot as any).physicsSettings)
  const overrides = (bot as any).physicsSettings?.overrides
  if (overrides != null) Object.assign(ctx, overrides)
  const state = ctx.state
  if (state.slowFalling > 0 || state.levitation > 0) return null
  state.control = controls.clone()
  // the keys of the tick before as the bot's engine kept them (the sneak the crouch follows, the jump a glide waits on)
  const prev = (e as { prevControl?: ControlStateHandler }).prevControl
  if (prev != null && typeof prev.clone === 'function') state.prevControl = prev.clone()

  const world = worldOpt ?? (bot as any).physicsWorld ?? { getBlock: (pos: Vec3) => bot.blockAt(pos, false) }
  const from = e.position.clone()
  const jump = controls.jump

  engine.simulate(ctx, world)
  // A walk off an edge stays on the ground the tick it leaves it (the move's y goes first, onto the block it's
  // leaving: Entity.collide), and falls from the next: off it is a box with no ground within the step height under it
  // (as Player.maybeBackOffFromEdge has it, the box moved down by maxUpStep free of the world)
  if (state.onGround && !overEdge(engine, world, state)) return null
  const over = state.pos.clone()
  // only the first tick's keys are this tick's: the rest is followed with them held or with none (holdKeys)
  if (!holdKeys) state.control = ControlStateHandler.DEFAULT()
  if (state.onGround) engine.simulate(ctx, world)

  let depth: number | null = null
  let lava = false
  const limit = jump ? MAX_JUMP_TICKS : MAX_FALL_TICKS
  for (let t = 0; t < limit; t++) {
    if (state.isInWater || state.onClimbable || state.isInWeb || state.fallFlying) return null
    if (PORTALS.has(world.getBlock(state.pos.floored())?.name)) return null
    if (state.isInLava) {
      depth = Math.max(0, from.y - state.pos.y)
      lava = true
      break
    }
    // a landing with the box over no ground within the step height (the brink of a block it came down on, moving on
    // past it) is none: the fall goes on (on the ground there, a sneak holds nothing, the box over the drop already)
    if (state.onGround && !overEdge(engine, world, state)) {
      depth = from.y - state.pos.y
      break
    }
    // a fall past the allowed depth already: where it ends is the column's
    if (from.y - state.pos.y > allowed + DEPTH_EPSILON && state.vel.y < 0) break
    engine.simulate(ctx, world)
  }

  if (depth == null) {
    const bb = state.getBB()
    const land = landingUnder(world, bb.minX, bb.maxX, bb.minZ, bb.maxZ, state.pos.y, (bot.game as any)?.minY ?? -64)
    if (land == null || land.soft) return null
    depth = land.y === -Infinity ? Infinity : from.y - land.y
    lava = land.lava
  }

  if (!lava && depth <= allowed + DEPTH_EPSILON) return null
  return { depth, allowed, from, over, jump, lava }
}

/** ticks the bot's fall is followed to where it comes down (predictLanding), at most */
const MAX_LANDING_TICKS = 60

/**
 * Where the bot's feet come to rest with its keys let go, when it's in the air now (a jump, a fall, the top of a
 * swimmer's bob out of the water): its position the first tick it's on the ground, in water or lava, on a ladder or in
 * a web, as physics-util's engine (mineflayer's own physics) runs it with no input (LivingEntity.travel with none).
 * Null when it's already on the ground, in a liquid or climbing, rides, glides or flies, or comes down nowhere in
 * MAX_LANDING_TICKS (the void, a long fall).
 */
export function predictLanding (bot: Bot, opts: { world?: any, engine?: BotcraftPhysics } = {}): Vec3 | null {
  const e: any = bot.entity
  if (e == null || e.onGround === true || e.isInWater === true || e.isInLava === true || (bot as any).vehicle != null) return null
  const engine = opts.engine ?? new BotcraftPhysics(bot.registry)
  const ctx = EPhysicsCtx.FROM_BOT(engine, bot, (bot as any).physicsSettings)
  const overrides = (bot as any).physicsSettings?.overrides
  if (overrides != null) Object.assign(ctx, overrides)
  const state = ctx.state
  const rests = (): boolean => state.onGround || state.isInWater || state.isInLava || state.onClimbable || state.isInWeb
  if (rests() || state.flying || state.fallFlying) return null
  state.control = ControlStateHandler.DEFAULT()
  const world = opts.world ?? (bot as any).physicsWorld ?? { getBlock: (pos: Vec3) => bot.blockAt(pos, false) }
  for (let t = 0; t < MAX_LANDING_TICKS; t++) {
    engine.simulate(ctx, world)
    if (rests()) return state.pos.clone()
  }
  return null
}

/**
 * The guard over the bot's ticks (one physicsTickBegin listener, the last to run so the keys it sees are the tick's):
 * on a fall predictEdgeFall finds, the bot sneaks (Player.maybeBackOffFromEdge holds it at the edge whatever its speed)
 * and lets go of jump and sprint, and of the movement keys too if that still doesn't hold it. The sneak it put down it
 * lets go of once the keys no longer take the bot over. Each catch is emitted ('edgeGuard', the fall) and kept
 * (lastCatch) for a walk to fail its move by.
 */
export class EdgeGuard {
  /** off, on while `active()` says (the pathfinder: while it walks), or on for every tick */
  public mode: 'off' | 'auto' | 'always' = 'auto'
  /** the fall last caught, and at which of the guard's ticks */
  public lastCatch?: { tick: number, fall: EdgeFall }
  /** how many ticks it caught a fall on */
  public catches = 0
  public tick = 0

  /** the sneak is down because the guard put it down (no one else set it since) */
  private ownSneak = false
  private setting = false
  /** the physics' part of the tick: from the guard's look at the keys to physicsTick (its state put back on the bot) */
  private inPhysics = false
  private readonly tickEnd = (): void => { this.inPhysics = false }
  private suspended = 0
  private _engine?: BotcraftPhysics
  private readonly listener = (): void => {
    try {
      this.onTick()
    } finally {
      this.inPhysics = true
    }
  }

  private reorderQueued = false
  private readonly onNewListener = (event: string | symbol, fn: unknown): void => {
    // a listener added after the guard's runs after it: the guard is put back last, to see the keys it sets
    if (event !== 'physicsTickBegin' || fn === this.listener || this.reorderQueued) return
    this.reorderQueued = true
    queueMicrotask(() => {
      this.reorderQueued = false
      this.bot.off('physicsTickBegin', this.listener)
      this.bot.on('physicsTickBegin', this.listener)
    })
  }

  constructor (private readonly bot: Bot, private readonly opts: EdgeGuardOptions & { active?: () => boolean }) {
    // a sneak the bot's own steering sets (an executor's at a bridge's edge) is its own, not the guard's to let go
    const setControlState = bot.setControlState.bind(bot)
    bot.setControlState = (control, state) => {
      // (not the physics' own: the engine's state puts its keys back on the bot each tick, PlayerState.apply)
      if (control === 'sneak' && !this.setting && !this.inPhysics) this.ownSneak = false
      setControlState(control, state)
    }
    bot.on('physicsTickBegin', this.listener)
    bot.prependListener('physicsTick', this.tickEnd)
    ;(bot as any).on('newListener', this.onNewListener)
  }

  private get engine (): BotcraftPhysics {
    this._engine ??= new BotcraftPhysics(this.bot.registry)
    return this._engine
  }

  private set (control: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sprint' | 'sneak', state: boolean): void {
    this.setting = true
    try {
      this.bot.setControlState(control, state)
    } finally {
      this.setting = false
    }
  }

  /** the guard stops (its listeners off) */
  public stop (): void {
    this.bot.off('physicsTickBegin', this.listener)
    this.bot.off('physicsTick', this.tickEnd)
    ;(this.bot as any).off('newListener', this.onNewListener)
  }

  /**
   * The guard let off till the returned release is called (a drop meant: a jump into the void's portal, a glide's
   * launch). Calls nest.
   */
  public suspend (): () => void {
    this.suspended++
    let released = false
    return () => {
      if (released) return
      released = true
      this.suspended--
    }
  }

  public get isActive (): boolean {
    if (this.mode === 'off' || this.suspended > 0) return false
    return this.mode === 'always' || this.opts.active?.() === true
  }

  /** the fall caught since `sinceTick` (a tick of the guard's), if any */
  public caughtSince (sinceTick: number): EdgeFall | undefined {
    return this.lastCatch != null && this.lastCatch.tick >= sinceTick ? this.lastCatch.fall : undefined
  }

  /** the fall the bot's keys would start now (predictEdgeFall at the allowed drop), with no change to the keys */
  public predict (controls?: ControlStateHandler): EdgeFall | null {
    return predictEdgeFall(this.bot, this.opts.allowedDrop(), { controls, world: this.opts.world?.(), engine: this.engine, keysHeld: this.opts.keysHeld?.() ?? true })
  }

  private onTick (): void {
    this.tick++
    const bot = this.bot
    if (bot.entity == null) return
    // the sneak it put down last tick is let go, the keys judged as the bot's own steering left them
    if (this.ownSneak) {
      this.ownSneak = false
      if (bot.getControlState('sneak')) this.set('sneak', false)
    }
    if (!this.isActive) return
    let fall: EdgeFall | null
    try {
      fall = this.predict()
    } catch {
      return
    }
    if (fall == null) return

    if (bot.getControlState('jump')) this.set('jump', false)
    if (bot.getControlState('sprint')) this.set('sprint', false)
    if (!bot.getControlState('sneak')) {
      this.set('sneak', true)
      this.ownSneak = true
    }
    // the sneak's hold is the ground's under the move: on a step that's no higher than the step height over a deep
    // drop it isn't, and the keys that walk on are let go too
    try {
      if (this.predict() != null) {
        for (const key of ['forward', 'back', 'left', 'right'] as const) this.set(key, false)
      }
    } catch { }
    this.catches++
    this.lastCatch = { tick: this.tick, fall }
    bot.emit('edgeGuard', fall)
  }
}
