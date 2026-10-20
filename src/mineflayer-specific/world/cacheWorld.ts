/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-non-null-assertion */
import { Vec3 } from 'vec3'
import type { World as WorldType } from './worldInterface'
import { Bot } from 'mineflayer'
import { LRUCache } from 'lru-cache'

import interactables from './interactable'
import type { Block, BlockType, MCData, RayType } from '../../types'
import { AABB } from '@nxg-org/mineflayer-util-plugin'
import { Movement } from '../movements'
import { fasterGetBlock } from './utils'
import { PassageKind, Shape, openableByHand, passageKind } from './passages'

import pBlock from 'prismarine-block'
// uncomment below for no interop
// import * as pBlock from 'prismarine-block'

export class BlockInfo {
  static initialized = false
  static readonly interactableBlocks = new Set()
  static readonly blocksCantBreak = new Set<number>()
  static readonly blocksToAvoid = new Set()
  static readonly climbables = new Set()
  static readonly carpets = new Set()
  static readonly fences = new Set()
  static readonly replaceables = new Set<number>()
  static readonly liquids = new Set()
  static readonly waters = new Set()
  static readonly gravityBlocks = new Set()
  /** doors, fence gates and trapdoors a player opens by hand (all but the iron ones: BlockSetType.canOpenByHand) */
  static readonly openable = new Set<number>()
  /** doors, fence gates and trapdoors, the iron ones too: gone through by their state's shapes, never dug (passages.ts) */
  static readonly passages = new Map<number, PassageKind>()
  static readonly emptyBlocks = new Set()
  static readonly mlgItems = new Set<number>()
  /** ice that turns to water when broken over a liquid or a solid block (IceBlock.playerDestroy: meltsInto) */
  static readonly meltingIce = new Set<number>()

  static readonly INVALID: BlockInfo = new BlockInfo(false, false, false, false, false, false, false, 0, false, new Vec3(0, 0, 0), -1)
  static PBlock: BlockType

  static _waterBlock: Block
  static _solidBlock: Block
  static _airBlock: Block
  static _replaceableBlock: Block

  static soulsandId: number
  static substituteBlockStateId: number

  public additionalLoaded = false
  private _waterAround = false
  private _fallBlockOver = false

  public get waterAround (): boolean {
    return this._waterAround
  }

  public get fallBlockOver (): boolean {
    return this._fallBlockOver
  }

  public get dY (): number {
    return this.height - this.position.y
  }

  public readonly solidFull: boolean
  public readonly isInvalid: boolean

  constructor (
    public readonly replaceable: boolean,
    public readonly canFall: boolean,
    public readonly walkthrough: boolean,
    public readonly safe: boolean,
    public readonly physical: boolean,
    public readonly liquid: boolean,
    public readonly climbable: boolean,
    public readonly height: number,
    public readonly openable: boolean,
    public readonly position: Vec3,
    // comp only
    public readonly type: number,
    public readonly block: Block | null = null
  ) {
    // this.solidFull = physical
    this.solidFull = this.height - this.position.y >= 1 && this.physical
    this.isInvalid = this.type === -1
  }

  /** the version the block sets were made for (init) */
  static version?: string

  static init (registry: MCData): void {
    // The sets are by block id, which differ from version to version: a bot of another version than the last one's
    // (another bot in the process, the next test) makes them again. Made once for the first, a 26.3 bot after a
    // 1.20.4 one took water's id for another block's, and planned no swim.
    const version = (registry as any).version?.minecraftVersion as string | undefined
    if (BlockInfo.initialized && BlockInfo.version === version) return
    if (BlockInfo.initialized) BlockInfo.clearSets()
    BlockInfo.initialized = true
    BlockInfo.version = version

    if (registry.blocksByName.soul_sand?.id != null) {
      BlockInfo.soulsandId = registry.blocksByName.soul_sand.id // might be broke, who knows
    } else {
      throw new Error('soul sand not found in registry')
    }

    BlockInfo.PBlock = pBlock(registry) // require('prismarine-block')(registry)
    BlockInfo.substituteBlockStateId = registry.blocksByName.dirt.minStateId

    BlockInfo._waterBlock = BlockInfo.PBlock.fromStateId(registry.blocksByName.water.minStateId, 0)
    BlockInfo._waterBlock.position = new Vec3(0, 0, 0)
    BlockInfo._solidBlock = BlockInfo.PBlock.fromStateId(registry.blocksByName.dirt.minStateId, 0)
    BlockInfo._solidBlock.position = new Vec3(0, 0, 0)
    BlockInfo._airBlock = BlockInfo.PBlock.fromStateId(registry.blocksByName.air.minStateId, 0)
    BlockInfo._airBlock.position = new Vec3(0, 0, 0)
    BlockInfo._replaceableBlock = BlockInfo.PBlock.fromStateId(registry.blocksByName.air.minStateId, 0) // also replaceable
    BlockInfo._replaceableBlock.position = new Vec3(0, 0, 0)

    interactables.forEach((b) => BlockInfo.interactableBlocks.add(b))

    if (registry.blocksByName.chest != null) BlockInfo.interactableBlocks.add(registry.blocksByName.chest.id)
    if (registry.blocksByName.ender_chest != null) BlockInfo.interactableBlocks.add(registry.blocksByName.ender_chest.id)

    registry.blocksArray.forEach((block) => {
      if (block.diggable == null || block.diggable) return
      if (block.id == null) return
      BlockInfo.blocksCantBreak.add(block.id)
    })

    for (const name of ['ice', 'frosted_ice']) {
      const id = registry.blocksByName[name]?.id
      if (id != null) BlockInfo.meltingIce.add(id)
    }
    BlockInfo.blocksToAvoid.add(registry.blocksByName.fire.id)
    // the rest of what hurts to stand in: soul fire, powder snow (a player sinks in and freezes: PowderSnowBlock), berry
    // bushes and wither roses
    for (const name of ['soul_fire', 'powder_snow', 'sweet_berry_bush', 'wither_rose']) {
      const id = registry.blocksByName[name]?.id
      if (id != null) BlockInfo.blocksToAvoid.add(id)
    }

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.cobweb) BlockInfo.blocksToAvoid.add(registry.blocksByName.cobweb.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.web) BlockInfo.blocksToAvoid.add(registry.blocksByName.web.id)

    BlockInfo.blocksToAvoid.add(registry.blocksByName.lava.id)

    BlockInfo.liquids.add(registry.blocksByName.water.id)
    BlockInfo.waters.add(registry.blocksByName.water.id)
    BlockInfo.replaceables.add(registry.blocksByName.water.id)

    BlockInfo.liquids.add(registry.blocksByName.lava.id)
    BlockInfo.replaceables.add(registry.blocksByName.lava.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.seagrass) {
      BlockInfo.liquids.add(registry.blocksByName.seagrass.id)
      BlockInfo.waters.add(registry.blocksByName.seagrass.id)
      BlockInfo.replaceables.add(registry.blocksByName.seagrass.id)
    }

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.tall_seagrass) {
      BlockInfo.liquids.add(registry.blocksByName.tall_seagrass.id)
      BlockInfo.waters.add(registry.blocksByName.tall_seagrass.id)
      BlockInfo.replaceables.add(registry.blocksByName.tall_seagrass.id)
    }

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.kelp_plant) {
      BlockInfo.liquids.add(registry.blocksByName.kelp_plant.id)
      BlockInfo.waters.add(registry.blocksByName.kelp_plant.id)
      BlockInfo.replaceables.add(registry.blocksByName.kelp_plant.id)
    }

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.kelp) {
      BlockInfo.liquids.add(registry.blocksByName.kelp.id)
      BlockInfo.waters.add(registry.blocksByName.kelp.id)
      BlockInfo.replaceables.add(registry.blocksByName.kelp.id)
    }

    BlockInfo.gravityBlocks.add(registry.blocksByName.sand.id)
    BlockInfo.gravityBlocks.add(registry.blocksByName.gravel.id)

    BlockInfo.climbables.add(registry.blocksByName.ladder.id)
    // BlockInfo.climbables.add(registry.blocksByName.vine.id)

    BlockInfo.replaceables.add(registry.blocksByName.air.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.cave_air) BlockInfo.replaceables.add(registry.blocksByName.cave_air.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.void_air) BlockInfo.replaceables.add(registry.blocksByName.void_air.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.tall_grass) BlockInfo.replaceables.add(registry.blocksByName.tall_grass.id)

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (registry.blocksByName.grass) BlockInfo.replaceables.add(registry.blocksByName.grass.id)

    registry.blocksArray
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .filter((x) => x.minStateId !== undefined)

      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      .map((x) => BlockInfo.PBlock.fromStateId(x.minStateId, 0))
      .forEach((block) => {
        if (block.shapes.length > 0) {
          // Fences or any block taller than 1, they will be considered as non-physical to avoid
          // trying to walk on them
          if (block.shapes[0][4] > 1) BlockInfo.fences.add(block.type)
          // Carpets or any blocks smaller than 0.1, they will be considered as safe to walk in
          if (block.shapes[0][4] < 0.1) BlockInfo.carpets.add(block.type)
        } else if (block.shapes.length === 0) {
          BlockInfo.emptyBlocks.add(block.type)
        }
      })

    registry.blocksArray.forEach((block) => {
      if (block.name == null) return
      const kind = passageKind(block.name)
      if (kind == null) return
      BlockInfo.passages.set(block.id, kind)
      if (openableByHand(block.name)) BlockInfo.openable.add(block.id)
    })
  }

  /** empties the sets init makes (another version's ids) */
  private static clearSets (): void {
    for (const set of [BlockInfo.interactableBlocks, BlockInfo.blocksCantBreak, BlockInfo.blocksToAvoid, BlockInfo.climbables,
      BlockInfo.carpets, BlockInfo.fences, BlockInfo.replaceables, BlockInfo.liquids, BlockInfo.waters, BlockInfo.gravityBlocks,
      BlockInfo.openable, BlockInfo.emptyBlocks, BlockInfo.mlgItems, BlockInfo.meltingIce]) {
      set.clear()
    }
    BlockInfo.passages.clear()
  }

  /** a door, fence gate or trapdoor (passages.ts): what kind, else null */
  public get passage (): PassageKind | null {
    return BlockInfo.passages.get(this.type) ?? null
  }

  /** the collision shapes of the block's state (none for a block not known) */
  public get shapes (): Shape[] {
    return (this.block?.shapes as Shape[] | undefined) ?? []
  }

  private _toggled?: BlockInfo | null

  /**
   * The block as a right click leaves it: `open` flipped (DoorBlock, FenceGateBlock and TrapDoorBlock.useWithoutItem;
   * a door's click flips both halves, each this way). Null for a block with no `open` state.
   */
  public toggled (): BlockInfo | null {
    if (this._toggled !== undefined) return this._toggled
    this._toggled = null
    const props = this.block?.getProperties?.() as Record<string, unknown> | undefined
    if (this.block != null && props != null && typeof props.open === 'boolean') {
      const flipped = (BlockInfo.PBlock as any).fromProperties(this.block.type, { ...props, open: !(props.open as boolean) }, 0) as Block
      flipped.position = this.position
      this._toggled = BlockInfo.fromBlock(flipped)
    }
    return this._toggled
  }

  static fromBlock (b: Block | null): BlockInfo {
    if (b === null) return BlockInfo.INVALID

    // a state with no collision shape is walked through whatever its block's box is (an open fence gate:
    // FenceGateBlock.getCollisionShape is empty when open; a tilted big dripleaf): minecraft-data gives the box per
    // block, the shapes per state
    if (b.boundingBox === 'block' && b.shapes.length > 0) {
      let height = b.position.y

      if (b.shapes.length === 1) height = b.position.y + b.shapes[0][4]
      else {
        for (const shape of b.shapes) {
          if (shape[4] !== 0 && height < b.position.y + shape[4]) height = b.position.y + shape[4]
        }
      }

      const climbable = BlockInfo.climbables.has(b.type)
      const safe = !BlockInfo.blocksToAvoid.has(b.type)
      return new BlockInfo(
        BlockInfo.replaceables.has(b.type),
        BlockInfo.gravityBlocks.has(b.type),
        (climbable || BlockInfo.carpets.has(b.type)) && safe,
        safe,
        true,
        false,
        climbable,
        height,
        BlockInfo.openable.has(b.type),
        b.position,
        b.type,
        b
      )
    } else {
      // no collision box: walked through, unless it's one to keep out of (lava, fire, cobwebs: blocksToAvoid)
      const safe = !BlockInfo.blocksToAvoid.has(b.type)
      return new BlockInfo(
        BlockInfo.replaceables.has(b.type),
        false,
        safe,
        safe,
        false,
        BlockInfo.liquids.has(b.type) || Boolean((b as any)._properties?.waterlogged),
        false,
        b.position.y,
        false,
        b.position,
        b.type,
        b
      )
    }
    // else {
    // throw new Error('lmao' + b.boundingBox)
    // const physical = b.boundingBox === 'block' && !BlockInfo.fences.has(b.type)
    // const climbable = BlockInfo.climbables.has(b.type)
    // let height = b.position.y

    // for (const shape of b.shapes) {
    //   height = Math.max(height, b.position.y + shape[4])
    // }

    // return new BlockInfo(
    //   BlockInfo.replaceables.has(b.type) && physical,
    //   BlockInfo.gravityBlocks.has(b.type),
    //   (b.boundingBox === 'empty' || climbable || BlockInfo.carpets.has(b.type)) && !BlockInfo.blocksToAvoid.has(b.type),
    //   physical,
    //   BlockInfo.liquids.has(b.type) || (Boolean((b as any)._properties?.waterlogged) && b.boundingBox === 'empty'),
    //   climbable,
    //   height,
    //   BlockInfo.openable.has(b.type),
    //   b.position,
    //   b.type,
    //   b
    // )
    // const b1 = {} as any // trick compiler into not doing pseudo class.
    // b1.climbable = BlockInfo.climbables.has(b.type)

    // // bug here, safe is not correct. Breaking climbables (ladders) is not cost of zero.
    // // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    // b1.safe = (b.boundingBox === 'empty' || b1.climbable || BlockInfo.carpets.has(b.type)) && !BlockInfo.blocksToAvoid.has(b.type)
    // b1.physical = b.boundingBox === 'block' && !BlockInfo.fences.has(b.type)

    // // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    // b1.replaceable = BlockInfo.replaceables.has(b.type) && !b1.physical
    // b1.liquid = BlockInfo.liquids.has(b.type) || (Boolean((b as any)._properties?.waterlogged) && b.boundingBox === 'empty')
    // b1.height = b.position.y
    // b1.canFall = BlockInfo.gravityBlocks.has(b.type)
    // b1.openable = BlockInfo.openable.has(b.type)

    // for (const shape of b.shapes) {
    //   b1.height = Math.max(b1.height, b.position.y + shape[4])
    // }

    // return new BlockInfo(
    //   b1.replaceable,
    //   b1.canFall,
    //   b1.safe,
    //   b1.physical,
    //   b1.liquid,
    //   b1.climbable,
    //   b1.height,
    //   b1.openable,
    //   b.position,
    //   b.type,
    //   b
    // )
    // }

    // return new BlockInfo(
    //   b1.replaceable,
    //   b1.canFall,
    //   b1.safe,
    //   b1.physical,
    //   b1.liquid,
    //   b1.climbable,
    //   b1.height,
    //   b1.openable,
    //   b.position,
    //   b.type,
    //   b
    // )
  }

  // static SOLID1: BlockInfo = new BlockInfo(false, false, false, true, false, false, 0, false, new Vec3(0, 0, 0), -1)
  static SOLID (pos: Vec3): BlockInfo {
    return new BlockInfo(false, false, false, true, true, false, false, pos.y + 1, false, pos, BlockInfo._solidBlock.type, BlockInfo._solidBlock)
  }

  // static AIR1: BlockInfo = new BlockInfo(true, false, true, false, false, false, 0, false, new Vec3(0, 0, 0), -1)
  static AIR (pos: Vec3): BlockInfo {
    return new BlockInfo(true, false, true, true, false, false, false, 0, false, pos, BlockInfo._airBlock.type, BlockInfo._airBlock)
  }

  // static REPLACEABLE1: BlockInfo = new BlockInfo(true, false, true, false, false, false, 0, false, new Vec3(0, 0, 0), -1)
  static REPLACEABLE (pos: Vec3): BlockInfo {
    return new BlockInfo(
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      0,
      false,
      pos,
      BlockInfo._replaceableBlock.type, // functionally identical for mining.
      BlockInfo._replaceableBlock
    )
  }

  // static WATER1: BlockInfo = new BlockInfo(false, false, false, false, true, false, 0, false, new Vec3(0, 0, 0), -1)
  static WATER (pos: Vec3): BlockInfo {
    return new BlockInfo(false, false, false, false, true, true, false, pos.y + 1, false, pos, BlockInfo._waterBlock.type, BlockInfo._waterBlock)
  }

  public getBBs (): AABB[] {
    if (this.block != null) {
      return this.block.shapes.map((shape) => AABB.fromShape(shape, this.position))
    } else {
      const hW = 0.5 // TODO: account for fences, chains, etc.
      return [
        new AABB(
          this.position.x - hW,
          this.position.y,
          this.position.z - hW,
          this.position.x + hW,
          this.height, // height is already y + certain elevation
          this.position.z + hW
        )
      ]
    }
  }

  public loadAdditionalInfo (movement: Movement): void {
    if (this.additionalLoaded) return
    this.additionalLoaded = true
    if (movement.settings.dontCreateFlow || movement.settings.dontMineUnderFallingBlock) {
      const top = movement.getBlockInfo(this.position, 0, 1, 0)
      // false if next to liquid

      if (movement.settings.dontCreateFlow) {
        if (top.liquid) this._waterAround = true
        else if (movement.getBlockInfo(this.position, -1, 0, 0).liquid) this._waterAround = true
        else if (movement.getBlockInfo(this.position, 1, 0, 0).liquid) this._waterAround = true
        else if (movement.getBlockInfo(this.position, 0, 0, -1).liquid) this._waterAround = true
        else if (movement.getBlockInfo(this.position, 0, 0, 1).liquid) this._waterAround = true
        // ice broken over water or the ground is water itself (IceBlock.playerDestroy: when the block below blocks
        // motion or is a liquid): a path under a frozen sea breaks its way along at head height and floods the cells
        // it walks, the ice keeping the bot under (a player drowned so on 26.3)
        else if (BlockInfo.meltingIce.has(this.type)) {
          const below = movement.getBlockInfo(this.position, 0, -1, 0)
          if (below.liquid || below.physical) this._waterAround = true
        }
      }

      if (movement.settings.dontMineUnderFallingBlock) {
        if (top.canFall) {
          this._fallBlockOver = true
        }
      }
    }
  }
}

// class Fuck {
//   // private arr: BlockInfo[];
//   private keyMap: { [key: string]: BlockInfo } = {}
//   private _size: number = 0

//   public get size () {
//     return this._size
//   }

//   constructor (public readonly maxSize: number) {
//     // this.arr = new Array<BlockInfo>(size);
//   }

//   get (key: string) {
//     return this.keyMap[key]
//   }

//   has (key: string) {
//     return !!this.keyMap[key]
//   }

//   set (key: string, block: BlockInfo) {
//     if (this.keyMap[key] == null) {
//       if (++this._size > this.maxSize) this.clear()
//       this.keyMap[key] = block
//     } else this.keyMap[key] = block
//   }

//   clear () {
//   // console.log('resetting')
//     this.keyMap = {}
//     this._size = 0
//   }
// }

export class CacheSyncWorld implements WorldType {
  blockInfos: LRUCache<string, BlockInfo>
  cacheCalls = 0
  enabled = true
  private readonly referenceWorld?: Bot['world']

  /**
   * The world read: the one given, else the bot's. mineflayer makes bot.world on the login packet (blocks.js'
   * switchWorld), so a pathfinder loaded with the bot, before it logs in (a client that loads its plugins at
   * createBot), has none yet to hold on to.
   */
  get world (): Bot['world'] {
    return this.referenceWorld ?? this.bot.world
  }

  /** the level's lowest y (from the login packet and every respawn into another dimension) */
  get minY (): number {
    return (this.bot.game as any)?.minY
  }

  constructor (private readonly bot: Bot, referenceWorld?: Bot['world']) {
    // this.posCache = {};

    this.blockInfos = this.makeLRUCache(100000)

    this.referenceWorld = referenceWorld

    // a new level (a portal, the End's exit, a respawn in another dimension): mineflayer unloads the old level's
    // columns into the same world without a blockUpdate for each block, so what's cached is another level's
    bot.on('worldSwitch' as any, () => this.clearCache())

    const onBlockUpdate = (oldBlock: Block | null, newBlock: Block): void => {
      // console.log(newBlock.position)
      const pos = newBlock.position
      if (this.blockInfos.has(`${pos.x}:${pos.y}:${pos.z}`)) {
        this.blockInfos.set(`${pos.x}:${pos.y}:${pos.z}`, BlockInfo.fromBlock(newBlock))
      }
    }
    // the bot's world's blockUpdate comes on the bot too (blocks.js' listener proxy), whenever the world is made
    if (referenceWorld != null) referenceWorld.on('blockUpdate', onBlockUpdate)
    else bot.on('blockUpdate', onBlockUpdate as any)

    // this.world.getBlock = fasterGetBlock.bind(this.world)
  }

  private makeLRUCache (size: number): CacheSyncWorld['blockInfos'] {
    // return new Fuck(size);

    // const count = 0
    return new LRUCache<string, BlockInfo, unknown>({
      max: size,
      ttl: 10000,
      updateAgeOnHas: false,
      updateAgeOnGet: true,
      dispose: (key, value, reason) => {
        if (reason === 'set') {
          // console.log(`${count++} disposed ${key.position.toString()} ${reason}`, this.blockInfos.size)
          this.blockInfos.clear()
        } else if (reason === 'evict') {
          // console.log('resetting', this.blockInfos.size)
          this.blockInfos.clear()
          this.blockInfos = this.makeLRUCache(size)
        }
      }
    })
  }

  raycast (from: Vec3, direction: Vec3, range: number, matcher?: ((block: Block) => boolean) | undefined): RayType | null {
    return this.world.raycast(from, direction, range, matcher) as unknown as RayType | null
  }

  getBlock (pos: Vec3): Block | null {
    if (!this.enabled) {
      return this.world.getBlock(pos) as unknown as Block
    }
    this.cacheCalls++
    pos = pos.floored()
    const key = `${pos.x}:${pos.y}:${pos.z}`

    // guaranteed behavior.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (this.blockInfos.has(key)) return this.blockInfos.get(key)!.block
    const block = this.world.getBlock(pos)
    if (block !== null) this.blockInfos.set(key, BlockInfo.fromBlock(block))
    return block
  }

  getBlockInfo (pos: Vec3): BlockInfo {
    // this.cacheCalls++
    // return BlockInfo.fromBlock(this.world.getBlock(pos))

    if (!this.enabled) {
      return BlockInfo.fromBlock(this.world.getBlock(pos))
    }
    this.cacheCalls++
    pos = pos.floored()
    const key = `${pos.x}:${pos.y}:${pos.z}`

    if (!this.blockInfos.has(key)) {
      const block = this.world.getBlock(pos)
      if (block === null) return BlockInfo.INVALID
      const blockInfo = BlockInfo.fromBlock(block)
      this.blockInfos.set(key, blockInfo)
      // console.log('didnt have info:', key, blockInfo, this.blockInfos.get(key))
      return blockInfo
      // console.log("already have info:", key, this.blockInfos.get(key))
    }

    // guaranteed behavior.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.blockInfos.get(key)!
  }

  /** what the cache holds for the block at `pos`, without reading the world or touching the entry's age */
  peekBlockInfo (pos: Vec3): BlockInfo | undefined {
    if (!this.enabled) return undefined
    return this.blockInfos.peek(`${Math.floor(pos.x)}:${Math.floor(pos.y)}:${Math.floor(pos.z)}`)
  }

  getBlockStateId (pos: Vec3): number | undefined {
    if (!this.enabled) {
      return this.world.getBlockStateId(pos) as unknown as number
    }
    this.cacheCalls++
    pos = pos.floored()
    const key = `${pos.x}:${pos.y}:${pos.z}`
    // const state = this.posCache[key]?.stateId
    // if (state !== undefined) return state
    // const state1 = this.world.getBlockStateId(pos);
    // if (state1 !== undefined) this.posCache[key] = CacheSyncWorld.Block.fromStateId(state1, 0)
    // return state1
    if (this.blockInfos.has(key)) return this.blockInfos.get(key)!.block?.stateId
    const state = this.world.getBlock(pos)
    if (state !== undefined) this.blockInfos.set(key, BlockInfo.fromBlock(state))
    return state.stateId
  }

  getCacheSize (): string {
    const calls = this.cacheCalls
    this.cacheCalls = 0
    // const used = Object.keys(this.posCache).length === 0 ?  this.blocks : this.posCache
    const used = this.blockInfos
    return `size = ${used.size}; calls = ${calls}`
  }

  clearCache (): void {
    this.blockInfos.clear()
    this.cacheCalls = 0
  }

  setEnabled (enabled: boolean): void {
    this.enabled = enabled
  }

  cleanup (): void {
    this.clearCache()
  }
}
