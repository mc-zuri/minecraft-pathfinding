import { Bot } from 'mineflayer'
import { Move } from '../move'
import * as goals from '../goals'
import { World } from '../world/worldInterface'
import { Movement, MovementOptions, buildMovementOptions } from './movement'

import { MovementProvider as AMovementProvider } from '../../abstract'
import type { ExecutorMap } from '.'
import { Vec3 } from 'vec3'
import { Vec3Properties } from '../../types'
import { BlockInfo } from '../world/cacheWorld'
import { clearToFace } from '../world/passages'

/**
 * Movement provider.
 *
 * Provides movements to the pathfinder.
 */
export abstract class MovementProvider extends Movement {
  orgPos!: Vec3
  toClear!: Set<number>

  public constructor (bot: Bot, world: World, settings: Partial<MovementOptions> = {}) {
    super(bot, world, settings)
  }

  abstract movementDirs: Vec3[]

  /**
   * Whether a fall into the column dx, dz off the node, from the node's level, is one to live through: ground (or
   * water) within maxDropDown blocks under it (LivingEntity.causeFallDamage: a fall over 3 blocks hurts). Checked for
   * the gap a parkour jump crosses: a jump that falls short lands there.
   */
  protected fallSafe (node: Move, dx: number, dz: number): boolean {
    for (let dy = -1; dy >= -(this.settings.maxDropDown + 1); dy--) {
      const info = this.getBlockInfo(node, dx, dy, dz)
      if (info.physical || info.liquid) return !BlockInfo.blocksToAvoid.has(info.type)
    }
    return false
  }

  /**
   * Whether the move's player gets out of the cell it starts in: a door's, gate's or trapdoor's shapes there (an open
   * door's panel along a side) let its box by on its way out, as its state is when the move starts (a door the path
   * opened is open). Out of such a cell only a cardinal move goes, by a face the shapes leave clear; up and down are
   * not out of it. A move that sees to this itself (Forward: safeOrOpen) says yes.
   */
  leavesStartCell (start: Move, move: Move): boolean {
    const dx = Math.sign(Math.floor(move.exitPos.x) - start.x)
    const dz = Math.sign(Math.floor(move.exitPos.z) - start.z)
    if (dx === 0 && dz === 0) return true
    for (const [dy, part] of [[0, 'feet'], [1, 'head']] as const) {
      const cell = this.getBlockInfo(start, 0, dy, 0)
      if (cell.passage == null || cell.shapes.length === 0) continue
      if (dx !== 0 && dz !== 0) return false
      if (!clearToFace(cell.shapes, dx, dz, part)) return false
    }
    return true
  }

  private boundaries!: [x: number, z: number, y: number]
  // private halfway!: [x: number, z: number, y: number]
  private orgX = 0
  private orgY = 0
  private orgZ = 0
  private boundaryX = 0
  private boundaryZ = 0
  private boundaryY = 0
  private halfX = 0
  private halfZ = 0
  private halfY = 0
  private xStride = 0
  private zStride = 0

  /**
   * Simulation-time calculation.
   *
   * Decide whether or not movement is possible.
   * If possible, append to provided storage.
   *
   *
   * @param {Move} start
   * @param {Move[]} storage put all resulting moves to this storage
   * @param {goals.Goal} goal
   * @param {Set<string>} closed Closed set of hashed positions for movements. Use this to cancel calculation early.
   */
  abstract provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void

  private localData: Array<BlockInfo | null> = []

  loadLocalData (
    orgPos: Vec3,
    boundaries: [x: number, z: number, y: number],
    arr: Array<BlockInfo | null>,
    clear: Set<number>
  ): void {
    this.orgPos = orgPos
    this.orgX = orgPos.x
    this.orgY = orgPos.y
    this.orgZ = orgPos.z
    this.localData = arr
    if (this.boundaries !== boundaries) {
      this.boundaries = boundaries
      // this.halfway = [Math.floor(boundaries[0] / 2), Math.floor(boundaries[1] / 2), Math.floor(boundaries[2] / 2)]
      this.boundaryX = boundaries[0]
      this.boundaryZ = boundaries[1]
      this.boundaryY = boundaries[2]
      this.halfX = Math.floor(boundaries[0] / 2)
      this.halfZ = Math.floor(boundaries[1] / 2)
      this.halfY = Math.floor(boundaries[2] / 2)
      this.zStride = boundaries[2]
      this.xStride = boundaries[2] * boundaries[1]
    }
    this.toClear = clear
    // console.log(this.halfway)
  }

  getBlockInfo (pos: Vec3Properties, dx: number, dy: number, dz: number): BlockInfo {
    return this.getBlockInfoAt(Math.floor(pos.x) + dx, Math.floor(pos.y) + dy, Math.floor(pos.z) + dz)
  }

  getBlockInfoRaw (yes: Vec3): BlockInfo {
    return this.getBlockInfoAt(yes.x, yes.y, yes.z, yes)
  }

  private getBlockInfoAt (x: number, y: number, z: number, pos?: Vec3): BlockInfo {
    const wantedDx = x - this.orgX + this.halfX
    const wantedDz = z - this.orgZ + this.halfZ
    const wantedDy = y - this.orgY + this.halfY

    if (
      wantedDx < 0 ||
      wantedDx >= this.boundaryX ||
      wantedDz < 0 ||
      wantedDz >= this.boundaryZ ||
      wantedDy < 0 ||
      wantedDy >= this.boundaryY
    ) {
      return this.world.getBlockInfo(pos ?? new Vec3(x, y, z))
    }

    const idx = wantedDx * this.xStride + wantedDz * this.zStride + wantedDy
    const data = this.localData[idx]

    if (data !== null) {
      return data
    }

    const ret = this.world.getBlockInfo(pos ?? new Vec3(x, y, z))
    this.localData[idx] = ret
    return ret
  }
}

/** a move by its kind and its blocks: what a failed move is remembered by (MovementHandler.avoid) */
export function moveKey (move: Move): string {
  const a = move.entryPos
  const b = move.exitPos
  return `${move.moveType.constructor.name}:${Math.floor(a.x)},${Math.floor(a.y)},${Math.floor(a.z)}>${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)}`
}

export class MovementHandler implements AMovementProvider<Move> {
  recognizedMovements: MovementProvider[]
  /** moves (moveKey) the search leaves out: ones that failed in this goto */
  avoid?: ReadonlySet<string>
  goal!: goals.Goal
  world: World

  constructor (bot: Bot, world: World, recMovement: MovementProvider[]) {
    this.world = world
    this.recognizedMovements = recMovement
    this.initIndexCoordinates()
  }

  static create (
    bot: Bot,
    world: World,
    recMovement: ExecutorMap,
    settings: Partial<MovementOptions> = {}
  ): MovementHandler {
    const opts = buildMovementOptions(settings)
    return new MovementHandler(
      bot,
      world,
      [...recMovement.keys()].map((M) => new M(bot, world, opts))
    )
  }

  sanitize (): boolean {
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    return !!this.goal
  }

  loadGoal (goal: goals.Goal): void {
    this.goal = goal
  }

  private readonly boundaries: [x: number, z: number, y: number] = [19, 19, 7]
  private readonly halfway: [x: number, z: number, y: number] = [Math.floor(this.boundaries[0] / 2), Math.floor(this.boundaries[1] / 2), Math.floor(this.boundaries[2] / 2)]
  private readonly boundaryX = this.boundaries[0]
  private readonly boundaryZ = this.boundaries[1]
  private readonly boundaryY = this.boundaries[2]
  private readonly halfX = this.halfway[0]
  private readonly halfZ = this.halfway[1]
  private readonly halfY = this.halfway[2]
  private readonly xStride = this.boundaries[2] * this.boundaries[1]
  private readonly zStride = this.boundaries[2]

  private readonly maxBound = this.boundaries[0] * this.boundaries[1] * this.boundaries[2]
  private readonly toClear: Set<number> = new Set()
  private readonly localData: Array<BlockInfo | null> = new Array(this.maxBound).fill(null, 0, this.maxBound)
  private readonly indexX = new Int16Array(this.maxBound)
  private readonly indexY = new Int16Array(this.maxBound)
  private readonly indexZ = new Int16Array(this.maxBound)
  private readonly seenMarks = new Uint32Array(this.maxBound)
  private seenStamp = 0
  /** the cells preloadInteractData set from the last node's moves (their breaks and places), in that node's frame */
  private readonly interactIdx = new Int32Array(this.maxBound)
  private interactCount = 0

  private initIndexCoordinates (): void {
    for (let idx = 0; idx < this.maxBound; idx++) {
      const x = Math.floor(idx / this.xStride)
      const rest = idx % this.xStride
      this.indexX[idx] = x
      this.indexZ[idx] = Math.floor(rest / this.zStride)
      this.indexY[idx] = rest % this.zStride
    }
  }

  resetLocalData (): void {
    this.localData.fill(null)
    this.interactCount = 0
  }

  /**
   * Forgets the cells the last node's moves broke or placed (preloadInteractData): they are that node's branch of the
   * search, not the world, and the next node may be on another branch, where the block is still there. Kept, a block
   * one branch dug was air to every node expanded after it, and a Forward broke only its feet block, pressing into
   * the stone at its head.
   */
  private clearInteractData (): void {
    for (let i = 0; i < this.interactCount; i++) this.localData[this.interactIdx[i]] = null
    this.interactCount = 0
  }

  // Do not reassign localData, must do shift in place.

  private readonly swapArray = new Array(this.maxBound).fill(null)
  private readonly swapSet = new Array(this.maxBound)

  static count = 0
  static totCount = 0
  shiftLocalData (orgPos: Vec3, newPos: Vec3): void {
    const diffX = newPos.x - orgPos.x
    const diffY = newPos.y - orgPos.y
    const diffZ = newPos.z - orgPos.z

    if (diffX === 0 && diffY === 0 && diffZ === 0) return

    if (Math.abs(diffX) >= this.boundaryX || Math.abs(diffY) >= this.boundaryY || Math.abs(diffZ) >= this.boundaryZ) {
      this.resetLocalData()
      MovementHandler.totCount++
      return
    }

    let swapIdx = 0
    for (let idx = 0; idx < this.maxBound; idx++) {
      const data = this.localData[idx]
      if (data === null) continue

      const newX = this.indexX[idx] - diffX
      const newY = this.indexY[idx] - diffY
      const newZ = this.indexZ[idx] - diffZ

      if (newX >= 0 && newX < this.boundaryX && newY >= 0 && newY < this.boundaryY && newZ >= 0 && newZ < this.boundaryZ) {
        const newIdx = newX * this.xStride + newZ * this.zStride + newY

        this.swapArray[newIdx] = data

        this.swapSet[swapIdx++] = newIdx
      }

      this.localData[idx] = null
    }

    for (let i = 0; i < swapIdx; i++) {
      const idx = this.swapSet[i]
      this.localData[idx] = this.swapArray[idx]
      this.swapArray[idx] = null
    }
    if (swapIdx > 0) MovementHandler.count++
    MovementHandler.totCount++
  }

  preloadInteractData (orgPos: Vec3, move: Move): void {
    // data has already been shifted, no need to worry.
    let move1: Move | undefined = move
    let exit = false

    let seenStamp = ++this.seenStamp
    if (seenStamp === 0) {
      this.seenMarks.fill(0)
      seenStamp = ++this.seenStamp
    }

    // theoretically, this is incorrect. Newest iteration should occur, not oldest.
    // reverse by starting at root then traversing down.
    // or keep track of changes.
    while (move1 !== undefined && !exit) {
      const wantedDx = move1.x - orgPos.x + this.halfX
      const wantedDz = move1.z - orgPos.z + this.halfZ
      const wantedDy = move1.y - orgPos.y + this.halfY

      if (wantedDx < 0 || wantedDx >= this.boundaryX || wantedDz < 0 || wantedDz >= this.boundaryZ || wantedDy < 0 || wantedDy >= this.boundaryY) {
        exit = true
      }

      for (const m of move1.toPlace) {
        const wantedDx = m.x - orgPos.x + this.halfX
        const wantedDz = m.z - orgPos.z + this.halfZ
        const wantedDy = m.y - orgPos.y + this.halfY

        if (wantedDx < 0 || wantedDx >= this.boundaryX || wantedDz < 0 || wantedDz >= this.boundaryZ || wantedDy < 0 || wantedDy >= this.boundaryY) {
          exit = true
        } else {
          const idx = wantedDx * this.xStride + wantedDz * this.zStride + wantedDy
          if (this.seenMarks[idx] !== seenStamp) {
            this.localData[idx] = m.blockInfo
            this.seenMarks[idx] = seenStamp
            this.interactIdx[this.interactCount++] = idx
          }
        }
      }

      for (const m of move1.toBreak) {
        // idx is the index of the block in the localData array
        // idx is offset from current position
        const wantedDx = m.x - orgPos.x + this.halfX
        const wantedDz = m.z - orgPos.z + this.halfZ
        const wantedDy = m.y - orgPos.y + this.halfY

        if (wantedDx < 0 || wantedDx >= this.boundaryX || wantedDz < 0 || wantedDz >= this.boundaryZ || wantedDy < 0 || wantedDy >= this.boundaryY) {
          exit = true
        } else {
          const idx = wantedDx * this.xStride + wantedDz * this.zStride + wantedDy
          if (this.seenMarks[idx] !== seenStamp) {
            this.localData[idx] = m.blockInfo
            this.seenMarks[idx] = seenStamp
            this.interactIdx[this.interactCount++] = idx
          }
        }
      }
      move1 = move1.parent
    }
  }

  private lastPos?: Vec3
  getNeighbors (currentMove: Move, closed: Set<string>): Move[] {
    const moves: Move[] = []

    // console.log('hi')
    const pos = currentMove.entryPos.floored()
    const old = this.lastPos ?? pos
    this.clearInteractData()
    this.shiftLocalData(old, pos)
    this.preloadInteractData(pos, currentMove)
    this.lastPos = pos

    // const arr = new Array(this.maxBound).fill(null);

    for (const newMove of this.recognizedMovements) {
      newMove.loadMove(currentMove)
      newMove.loadLocalData(pos, this.boundaries, this.localData, this.toClear)
      const from = moves.length
      newMove.provideMovements(currentMove, moves, this.goal, closed)
      // (out of a doorway only by the way its door lets the bot by; no more blocks placed than the budget has left)
      for (let i = moves.length - 1; i >= from; i--) {
        if (moves[i].remainingBlocks < 0 || !newMove.leavesStartCell(currentMove, moves[i])) moves.splice(i, 1)
      }
    }

    if (this.avoid != null && this.avoid.size > 0) {
      for (let i = moves.length - 1; i >= 0; i--) {
        if (this.avoid.has(moveKey(moves[i]))) moves.splice(i, 1)
      }
    }

    // for (const move of moves) {
    //   const bl = move.moveType.getBlockInfo(move, 0, 0, 0)
    //   if (bl.liquid && move.toPlace.length > 0) {
    //     const blocksAtPoses = move.toPlace.map((p) => move.moveType.getBlockInfo(p, 0, 0, 0))
    //   // console.log(blocksAtPoses.map(i => [i, i.block?.getProperties(), (i.block as any)?._properties]))

    //     // throw new Error(`Liquid detected in toPlace: ${move.moveType.constructor.name} with placements ${move.toPlace.map((p) => p.vec).join(', ')} at pos ${move.vec.toString()} `)
    //   }
    // }
    // this.resetLocalData() // same speed, but less memory efficient.

    // console.log(moves.length, moves.map(m=>m.moveType.constructor.name))

    return moves

    // for differences less than 1 block, we only supply best movement to said block.

    // if (moves.length === 0) return moves

    // const visited = new Set()
    // for (const move of moves) {
    //   visited.add(move.hash)
    // }

    // // console.log(visited)

    // const ret = []
    // for (const visit of visited) {
    //   const tmp = moves.filter((m) => m.hash === visit)
    //   const wantedCost = stableSort1(tmp, (a, b) => a.cost - b.cost)[0].cost
    //   const wanted = tmp.filter((m) => m.cost === wantedCost).sort((a, b) => this.goal.heuristic(a) - this.goal.heuristic(b))[0]
    //   ret.push(wanted)
    // }

    // for (const move of moves) {
    //   (move as any).cost = Math.round(move.cost);
    // }

    // return ret
  }
}

// type Comparator<T> = (a: T, b: T) => number

// const defaultCmp: Comparator<any> = (a, b) => {
//   if (a < b) return -1
//   if (a > b) return 1
//   return 0
// }

// function stableSort1<T> (arr: T[], cmp: Comparator<T> = defaultCmp): T[] {
//   const stabilized = arr.map((el, index) => [el, index] as [T, number])
//   const stableCmp: Comparator<[T, number]> = (a, b) => {
//     const order = cmp(a[0], b[0])
//     if (order !== 0) return order
//     return a[1] - b[1]
//   }

//   stabilized.sort(stableCmp)
//   for (let i = 0; i < arr.length; i++) {
//     arr[i] = stabilized[i][0]
//   }

//   return arr
// }
