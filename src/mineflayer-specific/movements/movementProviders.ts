import { Vec3 } from 'vec3'
import * as goals from '../goals'
import { Move } from '../move'
import { Movement } from './movement'
import { BreakHandler, PlaceHandler } from './interactionUtils'
import { emptyVec } from '@nxg-org/mineflayer-physics-util/dist/physics/settings'
import { MovementProvider } from './movementProvider'
import { BlockInfo } from '../world/cacheWorld'
import {
  COST_INF,
  FALL_N_BLOCKS_COST,
  JUMP_ONE_BLOCK_COST,
  LADDER_UP_ONE_COST,
  WALK_OFF_BLOCK_COST,
  WALK_ONE_BLOCK_COST
} from './costs'

const PARKOUR_DIAGONAL_3_3_TRAVEL = Math.sqrt(18) // 3 by 3 offset.

// Small fixed tick penalty for the "forward" parkour landing (running across a
// gap onto a same-height block). It is slower than a clean jump-and-drop, so it
// pays a little extra. Kept as a placeholder until per-frame parkour timing exists.
const PARKOUR_FORWARD_LANDING_PENALTY = 3

// technically, the offsets are slow. Yeah, I know.
// However, removing those breaks the code. So I won't fix that for the time being. -Gen

export class IdleMovement extends MovementProvider {
  movementDirs: Vec3[] = []
  provideMovements (start: Move, storage: Move[]): void {}
  async performInit (thisMove: Move, currentIndex: number, path: Move[]): Promise<void> {}
  async performPerTick (thisMove: Move, tickCount: number, currentIndex: number, path: Move[]): Promise<boolean> {
    return true
  }
}

export class Forward extends MovementProvider {
  movementDirs = Movement.cardinalDirs

  /** (the cell it leaves is checked with the rest, opened if need be: getMoveForward's safeOrOpen) */
  override leavesStartCell (): boolean {
    return true
  }

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of this.movementDirs) {
      const off = start.cachedVec.plus(dir).floor()
      if (closed.has(`${off.x},${off.y},${off.z}`)) continue
      this.getMoveForward(start, dir, storage)
    }
  }

  getMoveForward (start: Move, dir: Vec3, neighbors: Move[]): void {
    const pos = start.cachedVec

    let cost = this.travelCost(1) // sprint/walk one block forward

    if (this.getBlockInfo(pos, 0, 0, 0).liquid) cost += this.settings.liquidCost

    const blockC = this.getBlockInfo(pos, dir.x, 0, dir.z)
    if (blockC.isInvalid) return // out of range.

    // a solid block at the feet is broken like the one at the head (safeOrBreak below), as baritone's
    // MovementTraverse does: a tunnel goes straight on, not up a block and down again (ForwardJump then
    // StraightDown) one step at a time

    const blockB = this.getBlockInfo(pos, dir.x, 1, dir.z)
    const blockD = this.getBlockInfo(pos, dir.x, -1, dir.z)

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []

    if (!blockD.physical && !blockC.liquid) {
      if (start.remainingBlocks <= 0) return // not enough blocks to place

      // if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // D intersects an entity hitbox
      if (!blockD.replaceable) {
        if ((cost += this.safeOrBreak(blockD, toBreak)) > COST_INF) return
      }

      if ((cost += this.safeOrPlace(blockD, toPlace, 'solid')) > COST_INF) return
    }

    // console.log('yay!')
    // console.log('hello?', cost, blockC.block, blockB.block, this.breakCost(blockC), this.breakCost(blockB))
    // out of the cell it stands in, and into the next: a door, gate or trapdoor in either is gone through by its
    // state's shapes, or opened when the click lets the bot by (safeOrOpen)
    if ((cost += this.safeOrOpen(this.getBlockInfo(pos, 0, 0, 0), dir, 'feet', 'leave', toBreak)) > COST_INF) return
    if ((cost += this.safeOrOpen(this.getBlockInfo(pos, 0, 1, 0), dir, 'head', 'leave', toBreak)) > COST_INF) return
    if ((cost += this.safeOrOpen(blockB, dir, 'head', 'enter', toBreak)) > COST_INF) return
    if ((cost += this.safeOrOpen(blockC, dir, 'feet', 'enter', toBreak)) > COST_INF) return
    // the door or gate opened to go through the cell it leaves is shut behind it
    cost += this.closeBehind(start, dir, toBreak)

    // Exclusion zones and deadly edges (standCost): blockC is where the bot's feet end up. Fold the step cost
    // in now (before the move exists) so Move.cost stays read-only.
    if ((cost += this.standCost(blockC)) > COST_INF) return

    // set cachedVec to center of wanted block
    neighbors.push(Move.fromPrevious(cost, blockC.position.offset(0.5, 0, 0.5), start, this, toPlace, toBreak))
  }
}

export class Diagonal extends MovementProvider {
  movementDirs = Movement.diagonalDirs

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of this.movementDirs) {
      const off = start.cachedVec.plus(dir).floor()
      if (closed.has(`${off.x},${off.y},${off.z}`)) continue
      this.getMoveDiagonal(start, dir, storage, goal)
    }
  }

  getMoveDiagonal (node: Move, dir: Vec3, neighbors: Move[], goal: goals.Goal): void {
    let cost = this.travelCost(Math.SQRT2) // one diagonal block is sqrt(2) blocks of travel

    const block0 = this.getBlockInfo(node, dir.x, 0, dir.z)

    if (block0.isInvalid) return // out of range.

    if (!block0.walkthrough) return

    if (this.getBlockInfo(node, 0, 0, 0).liquid) cost += this.settings.liquidCost

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []
    const block00 = this.getBlockInfo(node, 0, 0, 0)

    if (block00.height - block0.height > 0.6) return // Too high to walk up
    // const needSideClearance = block00.height - block0.height < 0
    const block1 = this.getBlockInfo(node, dir.x, 1, dir.z)
    const blockN1 = this.getBlockInfo(node, dir.x, -1, dir.z)
    if (!blockN1.physical && !block0.liquid) {
      const blockCheck0 = this.getBlockInfo(node, 0, -1, dir.z)
      const blockCheck1 = this.getBlockInfo(node, dir.x, -1, 0)

      // first sol.
      if (!blockCheck0.physical && !blockCheck1.physical) {
        if (node.remainingBlocks <= 0) return // not enough blocks to place

        const wanted = blockCheck0
        if (!wanted.replaceable) {
          if ((cost += this.safeOrBreak(wanted, toBreak)) > COST_INF) return
        }
        if ((cost += this.safeOrPlace(wanted, toPlace, 'solid')) > COST_INF) return
      }

      if ((cost += this.safeOrPlace(blockN1, toPlace, 'solid')) > COST_INF) return
    }

    if (toPlace.length > 1 && !this.settings.allowDiagonalBridging) return

    // across two corners with a deadly fall in each (two of a basalt delta's lava shafts): the line is held up only
    // where the start's and the end's blocks touch, and a step off it goes down one of them
    if (this.settings.edgeHazardCost > 0 && toPlace.length === 0 && this.deadlyFall(node, dir.x, 0, 0) && this.deadlyFall(node, 0, 0, dir.z)) return

    // expect these to all be relatively easy.
    cost += this.safeOrBreak(block0, toBreak)
    cost += this.safeOrBreak(block1, toBreak)
    cost += this.safeOrBreak(this.getBlockInfo(node, dir.x, 0, 0), toBreak)
    cost += this.safeOrBreak(this.getBlockInfo(node, 0, 0, dir.z), toBreak)
    cost += this.safeOrBreak(this.getBlockInfo(node, dir.x, 1, 0), toBreak)
    cost += this.safeOrBreak(this.getBlockInfo(node, 0, 1, dir.z), toBreak)
    if (cost > COST_INF) return

    // Exclusion zones and deadly edges (standCost): block0 is the destination foot block.
    if ((cost += this.standCost(block0)) > COST_INF) return

    neighbors.push(Move.fromPrevious(cost, block0.position.offset(0.5, 0, 0.5), node, this, toPlace, toBreak))
  }
}

export class ForwardJump extends MovementProvider {
  movementDirs = Movement.cardinalDirs

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of this.movementDirs) {
      const off = start.cachedVec.plus(dir).floor()
      if (closed.has(`${off.x},${off.y + 1},${off.z}`)) continue
      this.getMoveJumpUp(start, dir, storage)
    }
  }

  /**
   * TODO: provide both non-sprint and sprint-jump moves here.
   * Saves time.
   * @param node
   * @param dir
   * @param neighbors
   * @returns
   */
  getMoveJumpUp (node: Move, dir: Vec3, neighbors: Move[]): void {
    // const pos = node.exitRounded(1)
    const pos = node.cachedVec
    const blockB = this.getBlockInfo(pos, dir.x, 1, dir.z)

    if (blockB.isInvalid) return // out of range.

    const blockA = this.getBlockInfo(pos, 0, 2, 0)
    const blockH = this.getBlockInfo(pos, dir.x, 2, dir.z)
    const blockC = this.getBlockInfo(pos, dir.x, 0, dir.z)

    // Jumping up one block: you move and rise at the same time, so the cost is
    // the slower of "walk one block" and "the jump arc", not their sum.
    let cost = Math.max(JUMP_ONE_BLOCK_COST, WALK_ONE_BLOCK_COST) + this.settings.jumpCost

    const block0 = this.getBlockInfo(pos, 0, 0, 0)
    if (block0.liquid) cost += this.settings.liquidCost

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []

    let cHeight = blockC.height

    // if (blockA.physical && (this.getNumEntitiesAt(blockA.position, 0, 1, 0) > 0)) return // Blocks A, B and H are above C, D and the player's space, we need to make sure there are no entities that will fall down onto our building space if we break them
    // if (blockH.physical && (this.getNumEntitiesAt(blockH.position, 0, 1, 0) > 0)) return
    // if (blockB.physical && !blockH.physical && !blockC.physical && (this.getNumEntitiesAt(blockB.position, 0, 1, 0) > 0)) return // It is fine if an ent falls on B so long as we don't need to replace block C

    // if liquid, allow swim movement up to it.
    if (!blockC.solidFull && !blockB.liquid) {
      if (node.remainingBlocks <= 0) return // not enough blocks to place

      // if (this.getNumEntitiesAt(blockC.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

      // console.log('blockC', blockC)
      const blockD = this.getBlockInfo(pos, dir.x, -1, dir.z)
      if (!blockD.solidFull) {
        if (node.remainingBlocks <= 1) return // not enough blocks to place

        // if (this.getNumEntitiesAt(blockD.position, 0, 0, 0) > 0) return // Check for any entities in the way of a block placement

        if (!blockD.replaceable) {
          if ((cost += this.breakCost(blockD)) > COST_INF) return
          toBreak.push(BreakHandler.fromVec(blockD.position, 'solid'))
        }
        if ((cost += this.safeOrPlace(blockD, toPlace, 'solid')) > COST_INF) return
      }

      if (!blockC.replaceable) {
        if ((cost += this.breakCost(blockC)) > COST_INF) return
        toBreak.push(BreakHandler.fromVec(blockC.position, 'solid'))
      }

      if ((cost += this.safeOrPlace(blockC, toPlace, 'solid')) > COST_INF) return

      cHeight += 1
    }

    const block1 = this.getBlockInfo(pos, 0, -1, 0)
    // the floor the jump goes up from: the ground under the node, or for a swimmer at the top of the water (the node's
    // cell water, air over it) the cell's own floor: holding jump keeps it at the surface, and against a wall it is
    // lifted out (LivingEntity.travel: horizontalCollision with room 0.6 up, a 0.3 rise), as a player climbs out of
    // the water onto a block a block over its surface cell's floor. Over deep water (no ground under it) the jump out
    // was never planned, and a 26.3 bot in a flooded hole had no way out but a dig through the ledge (fresh-z).
    const surface = BlockInfo.waters.has(block0.type) && !this.getBlockInfo(pos, 0, 1, 0).liquid
    const floor = surface ? Math.max(block1.height, Math.floor(pos.y)) : block1.height
    if (cHeight - floor > 1.2) return // Too high to jump

    if ((cost += this.safeOrBreak(blockA, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockB, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockH, toBreak)) > COST_INF) return
    if (toPlace.length > 0) return

    // a deadly fall beside the jump (a pit, the lava sea): a jump that goes wrong comes down there, and the executor
    // runs up to it from a standstill
    if (this.jumpHazard(pos, dir)) cost += this.settings.hazardJumpCost

    // Exclusion zones and deadly edges (standCost): blockB is the destination foot block.
    if ((cost += this.standCost(blockB)) > COST_INF) return

    // set cachedVec to center of block we want.
    neighbors.push(Move.fromPrevious(cost, blockB.position.offset(0.5, 0, 0.5), node, this, toPlace, toBreak))
  }
}

abstract class DropDownProvider extends MovementProvider {
  /**
   * Whether a fall down the column at `dir` from `node` into water at `waterY` passes a ledge a box off the column's
   * middle comes down on short of the water: ground with room over it (a physical block, a walkthrough one on it) in
   * any of the eight columns round the fall's, deeper than maxDropDown under the start and over the water. A box is
   * 0.6 wide, and a fall's drift (the run off the edge, the executor's steering) takes it over a side column: a 26.3
   * bot's drop of 42 into a cave's water landed on a ledge at y 29 and died (full-26.3-fresh-s). A shaft's walls, solid
   * all the way down, are none.
   */
  protected ledgeBesideFall (node: Move, dir: Vec3, waterY: number): boolean {
    // the highest block whose top is a fall of more than maxDropDown
    const top = node.y - this.settings.maxDropDown - 2
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        let above = this.getBlockInfo(node, dir.x + dx, top + 1 - node.y, dir.z + dz)
        for (let y = top; y >= waterY; y--) {
          const block = this.getBlockInfo(node, dir.x + dx, y - node.y, dir.z + dz)
          if (block.physical && above.walkthrough && !above.liquid) return true
          above = block
        }
      }
    }
    return false
  }

  getLandingBlock (orgBlock: BlockInfo, node: Move, dir: Vec3 = emptyVec): BlockInfo | null {
    // const chunk = this.bot.world.getColumn(node.x >> 4, node.z >> 4) as unknown as PCChunk;

    // TODO: optimize this.
    // If the chunk is cached, this will double our calculation speed.
    let min

    const startedInLiquid = orgBlock.liquid
    let blockLand
    if (startedInLiquid) {
      min = node.y - 1
      blockLand = this.getBlockInfo(node, dir.x, -1, dir.z)
    } else {
      blockLand = this.getBlockInfo(node, dir.x, -2, dir.z)
      if (this.settings.infiniteLiquidDropdownDistance) {
        min = (this.bot.game as any).minY
        // min = isBlockTypeInChunks(BlockInfo.WATER1.block!, chunk) ? (this.bot.game as any).minY : node.y - this.settings.maxDropDown;
      } else {
        // the ground's block, a block under the feet that land on it
        min = node.y - this.settings.maxDropDown - 1
      }
    }

    // min = node.y - this.settings.maxDropDown

    while (blockLand.position.y >= min) {
      if (blockLand.liquid && blockLand.walkthrough) {
        // a fall into water past maxDropDown: the water is the landing only for a box that falls clear of ground
        if (node.y - blockLand.position.y > this.settings.maxDropDown && this.ledgeBesideFall(node, dir, blockLand.position.y)) return null
        return blockLand
      }
      if (blockLand.physical) {
        // the drop is to the feet, on top of this block: a fall of maxDropDown is one to live through
        // (LivingEntity.calculateFallPower: the fall less SAFE_FALL_DISTANCE, 3), as fallSafe and deadlyFall have it
        if (node.y - (blockLand.position.y + 1) <= this.settings.maxDropDown) {
          return this.getBlockInfo(blockLand.position, 0, 1, 0)
        }
        // return null;
      }
      if (!blockLand.walkthrough) return null
      // console.log("before drop:", blockLand.position)
      blockLand = this.getBlockInfo(blockLand.position, 0, -1, 0)
      // console.log("after drop:", blockLand.position)if (node.y - blockLand.position.y <= this.settings.maxDropDown)
    }
    return null
  }
}

export class ForwardDropDown extends DropDownProvider {
  movementDirs = Movement.cardinalDirs

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of this.movementDirs) {
      // // // const off = start.cachedVec.plus(dir).floor()
      // // // // if (closed.has(`${off.x},${off.y},${off.z}`)) continue
      this.getMoveDropDown(start, dir, storage, closed)
    }
  }

  getMoveDropDown (node: Move, dir: Vec3, neighbors: Move[], closed: Set<string>): void {
    let cost = WALK_OFF_BLOCK_COST // step off the ledge

    const block0 = this.getBlockInfo(node, 0, 0, 0)
    const blockLand = this.getLandingBlock(block0, node, dir)

    if (blockLand == null) return
    if (blockLand.isInvalid) return // out of range.
    if (closed.has(`${blockLand.position.x},${blockLand.position.y},${blockLand.position.z}`)) return

    if (block0.liquid) cost += this.settings.liquidCost

    // ticks to fall the height we are dropping (whole blocks)
    cost += FALL_N_BLOCKS_COST[node.y - blockLand.position.y]

    const blockA = this.getBlockInfo(node, dir.x, 2, dir.z)
    const blockB = this.getBlockInfo(node, dir.x, 1, dir.z)
    const blockC = this.getBlockInfo(node, dir.x, 0, dir.z)
    const blockD = this.getBlockInfo(node, dir.x, -1, dir.z)

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []

    // if (!this.settings.infiniteLiquidDropdownDistance && node.y - blockLand.position.y > this.settings.maxDropDown) return; // Don't drop down into water

    // the landing's head room, in the landing's own column (the fall's: the dir is in blockLand's position already)
    const blockCheck0 = this.getBlockInfo(blockLand.position, 0, 1, 0)
    const blockCheck1 = this.getBlockInfo(blockLand.position, 0, 2, 0)

    if ((cost += this.safeOrBreak(blockCheck0, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockCheck1, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockA, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockB, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockC, toBreak)) > COST_INF) return
    if ((cost += this.safeOrBreak(blockD, toBreak)) > COST_INF) return

    // Exclusion zones and deadly edges (standCost): blockLand is where the bot lands and stands.
    if ((cost += this.standCost(blockLand)) > COST_INF) return

    // cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities
    neighbors.push(Move.fromPrevious(cost, blockLand.position.offset(0.5, 0, 0.5), node, this, toPlace, toBreak))
  }
}

export class StraightDown extends DropDownProvider {
  movementDirs = [new Vec3(0, -1, 0)]

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    const off = start.cachedVec.floored()
    if (closed.has(`${off.x},${off.y - 1},${off.z}`)) return
    return this.getMoveDown(start, storage, closed)
  }

  getMoveDown (node: Move, neighbors: Move[], closed: Set<string>): void {
    let cost = 0 // straight down has no horizontal travel; the fall below is the whole cost
    const block0 = this.getBlockInfo(node, 0, 0, 0)

    const blockLand = this.getLandingBlock(block0, node)
    if (blockLand == null) return
    if (blockLand.isInvalid) return // out of range.
    if (closed.has(`${blockLand.position.x},${blockLand.position.y},${blockLand.position.z}`)) return

    if (block0.liquid) cost += this.settings.liquidCost // dont go underwater

    // ticks to fall the height we are dropping (whole blocks)
    cost += FALL_N_BLOCKS_COST[node.y - blockLand.position.y]

    const block1 = this.getBlockInfo(node, 0, -1, 0)

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []

    if ((cost += this.safeOrBreak(block1, toBreak)) > COST_INF) return

    // Exclusion zones and deadly edges (standCost): blockLand is where the bot lands and stands.
    if ((cost += this.standCost(blockLand)) > COST_INF) return

    // cost += this.getNumEntitiesAt(blockLand.position, 0, 0, 0) * this.entityCost // add cost for entities

    neighbors.push(Move.fromPrevious(cost, blockLand.position.offset(0.5, 0, 0.5), node, this, toPlace, toBreak))
  }
}

export class StraightUp extends MovementProvider {
  movementDirs = [new Vec3(0, 1, 0)]

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    const off = start.cachedVec.floored()
    if (closed.has(`${off.x},${off.y + 1},${off.z}`)) return
    return this.getMoveUp(start, storage, closed)
  }

  getMoveUp (node: Move, neighbors: Move[], closed: Set<string>): void {
    const block1 = this.getBlockInfo(node, 0, 0, 0)

    if (block1.isInvalid) return // out of range.

    const block2 = this.getBlockInfo(node, 0, 2, 0)
    const block3 = this.getBlockInfo(node, 0, 1, 0) // the block the bot ends up standing in

    // a column of water the bot is in (the start's cell, the next and the one over it all water) is swum up as a
    // ladder is climbed (Baritone's MovementPillar: an ascending pillar of water costs a ladder's climb), the head
    // under water on the way to the top
    const waterColumn = block1.liquid && block3.liquid && block2.liquid

    // Climbing a ladder/vine has its own speed; otherwise we jump (and below we
    // may also place a block to tower up, which adds its own place cost).
    let cost = block1.climbable || waterColumn ? LADDER_UP_ONE_COST : JUMP_ONE_BLOCK_COST + this.settings.jumpCost

    if (block1.liquid && !waterColumn) cost += this.settings.liquidCost
    // if (this.getNumEntitiesAt(node, 0, 0, 0) > 0) return // an entity (besides the player) is blocking the building area

    const toBreak: BreakHandler[] = []
    const toPlace: PlaceHandler[] = []

    if ((cost += this.safeOrBreak(block2, toBreak)) > COST_INF) return

    if (!block1.climbable) {
      if (!block3.liquid) {
        if (!this.settings.allow1by1towers || node.remainingBlocks <= 0) return // not enough blocks to place

        // no tower from a cell of water (or lava): its block goes into the cell the bot swims in, and a swimmer's feet
        // never get over it (LivingEntity.aiStep: in a liquid deeper than the jump threshold the jump is jumpInLiquid's
        // 0.04 a tick, not jumpFromGround), the place 'Invalid placement' at each try, the bot's box in the cell (a 26.3
        // bot in a pool a block deep bobbed up to 64.96 under its place at 64, f9-26.3)
        if (block1.liquid) return

        if (!block1.replaceable) {
          if ((cost += this.breakCost(block1)) > COST_INF) return
          toBreak.push(BreakHandler.fromVec(block1.position, 'solid'))
        }

        if ((cost += this.safeOrPlace(block1, toPlace, 'solid')) > COST_INF) return

        const block0 = this.getBlockInfo(node, 0, -1, 0)

        if (block0.liquid) return // cant build in water
        if (block0.physical && block0.height - node.y < -0.2) return // cannot jump-place from a half block
      }
    }

    // Exclusion zones and deadly edges (standCost): block3 is where the bot's feet end up.
    if ((cost += this.standCost(block3, { waterColumn })) > COST_INF) return

    neighbors.push(Move.fromPrevious(cost, block1.position.offset(0.5, 1, 0.5), node, this, toPlace, toBreak))
  }
}

export class ParkourForward extends MovementProvider {
  movementDirs = Movement.cardinalDirs

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of Movement.cardinalDirs) {
      this.getMoveParkourForward(start, dir, storage, closed)
    }
  }

  // Jump up, down or forward over a 1 block gap
  getMoveParkourForward (node: Move, dir: Vec3, neighbors: Move[], closed: Set<string>): void {
    const block0 = this.getBlockInfo(node, 0, -1, 0)

    if (!block0.physical) return // cant jump from water

    const block00 = this.getBlockInfo(node, 0, 0, 0)
    if (block00.liquid) return

    const block1 = this.getBlockInfo(node, dir.x, -1, dir.z)
    if (
      (block1.physical && block1.height >= block0.height) ||
      !this.getBlockInfo(node, dir.x, 0, dir.z).walkthrough ||
      !this.getBlockInfo(node, dir.x, 1, dir.z).walkthrough
    ) {
      return
    }

    const cost0 = JUMP_ONE_BLOCK_COST + this.settings.jumpCost // the jump itself

    // Leaving entities at the ceiling level (along path) out for now because there are few cases where that will be important
    // cost += this.getNumEntitiesAt(node, dir.x, 0, dir.z) * this.entityCost

    // If we have a block on the ceiling, we cannot jump but we can still fall
    let ceilingClear = this.getBlockInfo(node, 0, 2, 0).walkthrough && this.getBlockInfo(node, dir.x, 2, dir.z).walkthrough

    // Similarly for the down path
    let floorCleared = !this.getBlockInfo(node, dir.x, -2, dir.z).physical

    const maxD = this.settings.allowSprinting ? 5 : 2

    for (let d = 2; d <= maxD; d++) {
      let cost = cost0 + this.travelCost(d) // jump plus sprinting across d blocks
      const dx = dir.x * d
      const dz = dir.z * d
      // the gap's columns: a jump that falls short lands in them (a ravine under a gap is a fall to die of)
      if (!this.fallSafe(node, dir.x * (d - 1), dir.z * (d - 1))) return

      const flag0 = /* true */ !closed.has(`${node.x + dx},${node.y - 1},${node.z + dz}`)
      const flag1 = /* true */ !closed.has(`${node.x + dx},${node.y},${node.z + dz}`)
      const flag2 = /* true */ !closed.has(`${node.x + dx},${node.y + 1},${node.z + dz}`)

      if (!flag0 && !flag1 && !flag2) return

      const blockA = this.getBlockInfo(node, dx, 2, dz)
      const blockB = this.getBlockInfo(node, dx, 1, dz)
      const blockC = this.getBlockInfo(node, dx, 0, dz)
      const blockD = this.getBlockInfo(node, dx, -1, dz)

      // ceilingClear &&= this.getBlockInfo(node, dx, 2, dx).safe

      // if (blockC.safe) cost += this.getNumEntitiesAt(blockC.position, 0, 0, 0) * this.entityCost

      if (flag0 && (ceilingClear || d === 2) && blockB.walkthrough && blockC.walkthrough && blockD.walkthrough && floorCleared) {
        // Down
        const blockE = this.getBlockInfo(node, dx, -2, dz)
        if (blockE.physical) { // TODO: support jumping into liquid.
          // Exclusion zones and deadly edges (standCost): blockD is the landing. Skip the move if it is forbidden.
          if ((cost += this.standCost(blockD)) < COST_INF) {
            neighbors.push(Move.fromPrevious(cost, blockD.position.offset(0.5, 0, 0.5), node, this))
          }
        }
        floorCleared = floorCleared && !blockE.physical
      } else if (flag1 && ceilingClear && blockB.walkthrough && blockC.walkthrough && blockD.physical) {
        // Forward
        cost += PARKOUR_FORWARD_LANDING_PENALTY
        if ((cost += this.standCost(blockC)) < COST_INF) {
          neighbors.push(Move.fromPrevious(cost, blockC.position.offset(0.5, 0, 0.5), node, this))
        }
        break
      } else if (flag2 && ceilingClear && blockA.walkthrough && blockB.walkthrough && blockC.physical) {
        // Up
        if (d === 5) continue

        // 4 Blocks forward 1 block up is very difficult and fails often
        if (blockC.height - block0.height > 1.2) break // Too high to jump
        if ((cost += this.standCost(blockB)) < COST_INF) {
          neighbors.push(Move.fromPrevious(cost, blockB.position.offset(0.5, 0, 0.5), node, this))
        }
        break
        // }
      } else if (!blockB.walkthrough || !blockC.walkthrough) {
        break
      }

      ceilingClear = ceilingClear && blockA.walkthrough
    }
  }
}

export class ParkourDiagonal extends MovementProvider {
  movementDirs = Movement.diagonalDirs

  /**
   * Jumps one over and two along (or two over and three along): off by default, the executor lines them up badly on a
   * real server (6 of 8 stuck trips on a jungle seed were these, the bot pressed into the corner it jumps past)
   */
  static allowOffsetDiagonals = false

  provideMovements (start: Move, storage: Move[], goal: goals.Goal, closed: Set<string>): void {
    for (const dir of Movement.diagonalDirs) {
      this.getMoveParkourDiagonal(start, dir, storage, closed)
    }
  }

  getMoveParkourDiagonal (node: Move, dir: Vec3, neighbors: Move[], closed: Set<string>): void {
    const block0 = this.getBlockInfo(node, 0, -1, 0)
    if (!block0.physical) return

    const block00 = this.getBlockInfo(node, 0, 0, 0)
    if (block00.liquid) return

    const block1Floor = this.getBlockInfo(node, dir.x, -1, dir.z)
    if (block1Floor.physical && block1Floor.height >= block0.height) return

    if (!this.getBlockInfo(node, dir.x, 0, dir.z).walkthrough) return
    if (!this.getBlockInfo(node, dir.x, 1, dir.z).walkthrough) return

    if (!this.getBlockInfo(node, dir.x, 0, 0).walkthrough) return
    if (!this.getBlockInfo(node, 0, 0, dir.z).walkthrough) return
    if (!this.getBlockInfo(node, dir.x, 1, 0).walkthrough) return
    if (!this.getBlockInfo(node, 0, 1, dir.z).walkthrough) return

    const cost0 = JUMP_ONE_BLOCK_COST + this.settings.jumpCost // the jump itself
    const maxD = this.settings.allowSprinting ? 4 : 2

    // old behavior
    for (let d = 2; d <= maxD; d++) {
      if (this.tryDiagonalLanding(node, dir, d, d, cost0, block0, neighbors, closed)) break
    }

    // new optional asymmetric behavior
    if (ParkourDiagonal.allowOffsetDiagonals) {
      for (let major = 2; major <= maxD; major++) {
        for (let minor = 1; minor < major; minor++) {
          if (minor === major) continue

          // check both (minor, major) and (major, minor)
          if (this.tryDiagonalLanding(node, dir, minor, major, cost0, block0, neighbors, closed)) return
          if (this.tryDiagonalLanding(node, dir, major, minor, cost0, block0, neighbors, closed)) return
        }
      }
    }
  }

  /**
   * Whether the player's box (0.6 wide) goes from the middle of the node's block to the middle of the one dx, dz off
   * without its feet or head cells meeting a block: the cells the line's box crosses on the way, past the ones
   * checked one by one (the jump's corners beside the line, as (2, 1) and (1, 2) on a jump two over and two along).
   */
  /** every column the jump's line crosses between its blocks has ground (or water) a safe fall below (fallSafe) */
  private gapFallSafe (node: Move, dx: number, dz: number): boolean {
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.25)
    for (let s = 1; s < steps; s++) {
      const x = Math.floor(0.5 + (dx * s) / steps)
      const z = Math.floor(0.5 + (dz * s) / steps)
      if ((x === 0 && z === 0) || (x === dx && z === dz)) continue
      if (!this.fallSafe(node, x, z)) return false
    }
    return true
  }

  private sweepClear (node: Move, dx: number, dz: number): boolean {
    const steps = Math.ceil(Math.hypot(dx, dz) / 0.1)
    const hW = 0.3
    const seen = new Set<string>()
    for (let s = 1; s < steps; s++) {
      const cx = 0.5 + (dx * s) / steps
      const cz = 0.5 + (dz * s) / steps
      for (let x = Math.floor(cx - hW); x <= Math.floor(cx + hW); x++) {
        for (let z = Math.floor(cz - hW); z <= Math.floor(cz + hW); z++) {
          if ((x === 0 && z === 0) || (x === dx && z === dz)) continue
          const key = `${x},${z}`
          if (seen.has(key)) continue
          seen.add(key)
          if (!this.getBlockInfo(node, x, 0, z).walkthrough || !this.getBlockInfo(node, x, 1, z).walkthrough) return false
        }
      }
    }
    return true
  }

  private tryDiagonalLanding (
    node: Move,
    dir: Vec3,
    xSteps: number,
    zSteps: number,
    cost0: number,
    block0: BlockInfo,
    neighbors: Move[],
    closed: Set<string>
  ): boolean {
    const dx = dir.x * xSteps
    const dz = dir.z * zSteps

    const travel = Math.sqrt(xSteps * xSteps + zSteps * zSteps)
    let cost = cost0 + this.travelCost(travel) // jump plus sprinting across the gap
    const majorIsX = xSteps > zSteps
    const majorIsZ = zSteps > xSteps
    const frontDx = dx - (majorIsX || xSteps === zSteps ? dir.x : 0)
    const frontDz = dz - (majorIsZ || xSteps === zSteps ? dir.z : 0)

    const flag0 = !closed.has(`${node.x + dx},${node.y - 1},${node.z + dz}`)
    const flag1 = !closed.has(`${node.x + dx},${node.y},${node.z + dz}`)
    const flag2 = !closed.has(`${node.x + dx},${node.y + 1},${node.z + dz}`)

    if (!flag0 && !flag1 && !flag2) return false

    const blockA = this.getBlockInfo(node, dx, 2, dz)
    const blockB = this.getBlockInfo(node, dx, 1, dz)
    const blockC = this.getBlockInfo(node, dx, 0, dz)
    const blockD = this.getBlockInfo(node, dx, -1, dz)
    const blockFrontD = this.getBlockInfo(node, frontDx, -1, frontDz)
    const blockFrontC = this.getBlockInfo(node, frontDx, 0, frontDz)
    const blockFrontB = this.getBlockInfo(node, frontDx, 1, frontDz)

    if (!this.getBlockInfo(node, dx, 0, 0).walkthrough) return false
    if (!this.getBlockInfo(node, 0, 0, dz).walkthrough) return false
    if (!this.getBlockInfo(node, dx, 1, 0).walkthrough) return false
    if (!this.getBlockInfo(node, 0, 1, dz).walkthrough) return false
    if (!this.sweepClear(node, dx, dz)) return false
    if (!this.gapFallSafe(node, dx, dz)) return false

    const blockE = this.getBlockInfo(node, dx, -2, dz)

    const ceilingClear =
      this.getBlockInfo(node, 0, 2, 0).walkthrough &&
      this.getBlockInfo(node, dx, 2, dz).walkthrough &&
      this.getBlockInfo(node, dx, 2, 0).walkthrough &&
      this.getBlockInfo(node, 0, 2, dz).walkthrough

    const floorCleared = !blockE.physical

    if (flag0 && ceilingClear && blockB.walkthrough && blockC.walkthrough && blockD.walkthrough && blockFrontD.walkthrough && !floorCleared) {
      if (blockE.physical) {
        if ((cost += this.standCost(blockD)) < COST_INF) {
          neighbors.push(Move.fromPrevious(cost, blockD.position.offset(0.5, 0, 0.5), node, this))
        }
        return true
      }
    } else if (flag1 && ceilingClear && blockB.walkthrough && blockC.walkthrough && blockD.physical && blockFrontC.walkthrough) {
      cost += PARKOUR_FORWARD_LANDING_PENALTY
      if ((cost += this.standCost(blockC)) < COST_INF) {
        neighbors.push(Move.fromPrevious(cost, blockC.position.offset(0.5, 0, 0.5), node, this))
      }
      return true
    } else if (flag2 && ceilingClear && blockA.walkthrough && blockB.walkthrough && blockC.physical && blockFrontB.walkthrough) {
      if (blockC.height - block0.height > 1.2) return false
      if (travel > PARKOUR_DIAGONAL_3_3_TRAVEL) return false
      if ((cost += this.standCost(blockB)) < COST_INF) {
        neighbors.push(Move.fromPrevious(cost, blockB.position.offset(0.5, 0, 0.5), node, this))
      }
      return true
    }

    return false
  }
}
