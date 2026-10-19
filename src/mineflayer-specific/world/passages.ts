// Doors, fence gates and trapdoors: blocks a player goes through by the shape of their state (open or closed, which
// way they face, the door's hinge), and opens or closes with a right click (DoorBlock, FenceGateBlock and
// TrapDoorBlock.useWithoutItem: `open` flipped; the iron ones only by redstone, BlockSetType.IRON.canOpenByHand false).
// minecraft-data's collision shapes are exact per state: a closed door is a 3/16 panel across one edge of its cell, an
// open one a panel along a side; a closed gate a bar across the middle, 1.5 high (it can't be jumped, as a fence), an
// open gate nothing.

/** a collision shape of a block, relative to it: [x0, y0, z0, x1, y1, z1] */
export type Shape = number[]

/** half a player's width (Player's dimensions: 0.6 wide, 1.8 high) */
const HALF = 0.3
const EPS = 1e-3
/** a shape no higher than this in the feet's cell is stepped onto (a closed bottom trapdoor, 3/16 high) */
const FLOOR = 0.2

export type PassagePart = 'feet' | 'head'

/**
 * Whether a player's box in the middle of a cell, moved from there to the face (dx, dz) (a cardinal), meets none of
 * the shapes: what is left of the cell when it goes out by that face, or before it is in the middle when it comes in
 * by it. `feet` is the cell its feet are in (a shape under FLOOR stepped onto), `head` the one above (its box 0.8 into
 * it).
 */
export function clearToFace (shapes: Shape[], dx: number, dz: number, part: PassagePart): boolean {
  const x0 = dx > 0 ? 0.5 - HALF : dx < 0 ? 0 : 0.5 - HALF
  const x1 = dx > 0 ? 1 : dx < 0 ? 0.5 + HALF : 0.5 + HALF
  const z0 = dz > 0 ? 0.5 - HALF : dz < 0 ? 0 : 0.5 - HALF
  const z1 = dz > 0 ? 1 : dz < 0 ? 0.5 + HALF : 0.5 + HALF
  const y0 = part === 'feet' ? FLOOR : 0
  const y1 = part === 'feet' ? 1 : 1.8 - 1
  for (const s of shapes) {
    if (part === 'feet' && s[4] <= FLOOR) continue
    if (s[0] < x1 - EPS && s[3] > x0 + EPS && s[1] < y1 - EPS && s[4] > y0 + EPS && s[2] < z1 - EPS && s[5] > z0 + EPS) return false
  }
  return true
}

/**
 * Whether a player's box at (x, z) (its middle, in the cell's coordinates) is past the shapes going (dx, dz): all of
 * the box beyond them that way, so that the closed door or gate behind it is shut with the bot out of it
 */
export function pastShapes (shapes: Shape[], dx: number, dz: number, x: number, z: number): boolean {
  for (const s of shapes) {
    if (dx > 0 && x - HALF < s[3] + EPS) return false
    if (dx < 0 && x + HALF > s[0] - EPS) return false
    if (dz > 0 && z - HALF < s[5] + EPS) return false
    if (dz < 0 && z + HALF > s[2] - EPS) return false
  }
  return true
}

export type PassageKind = 'door' | 'gate' | 'trapdoor'

/** what kind of passage a block is by its name, null for none (1.13+ names, and 1.12's wooden_door, trapdoor, fence_gate) */
export function passageKind (name: string): PassageKind | null {
  if (/(^|_)trap_?door$/.test(name)) return 'trapdoor'
  if (/(^|_)fence_gate$/.test(name)) return 'gate'
  if (/(^|_)door$/.test(name)) return 'door'
  return null
}

/** whether a player opens it by hand: every passage but the iron door and trapdoor (BlockSetType.canOpenByHand) */
export function openableByHand (name: string): boolean {
  return passageKind(name) != null && !name.startsWith('iron_')
}
