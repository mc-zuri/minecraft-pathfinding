import type { Bot } from 'mineflayer'
import type { Item } from 'prismarine-item'

/**
 * The blocks the bot builds with by default (MovementOptions.scaffoldingBlocks), as item names, cheapest first: full,
 * solid blocks (a whole cube of collision in every state) that don't fall (FallingBlock: no sand, gravel or concrete
 * powder), have no block entity, aren't leaves (they decay) and are worth little: the junk a mine or a walk through the
 * nether or the End leaves the bot with before the cobblestone its crafts want, and the planks last. A version's
 * registry may lack some (poplar from 26.3): those are never in an inventory.
 */
export const DEFAULT_SCAFFOLDING_BLOCKS: readonly string[] = Object.freeze([
  'dirt',
  'coarse_dirt',
  'netherrack',
  'andesite',
  'diorite',
  'granite',
  'tuff',
  'basalt',
  'end_stone',
  'cobbled_deepslate',
  'cobblestone',
  'blackstone',
  'deepslate',
  'stone',
  'sandstone',
  'oak_planks',
  'spruce_planks',
  'birch_planks',
  'jungle_planks',
  'acacia_planks',
  'dark_oak_planks',
  'mangrove_planks',
  'cherry_planks',
  'pale_oak_planks',
  'poplar_planks',
  'bamboo_planks',
  'crimson_planks',
  'warped_planks'
])

/** the items of the inventory that are scaffolding (`names`), each stack with a count */
function scaffoldStacks (bot: Bot, names: readonly string[]): Item[] {
  return bot.inventory.items().filter((item) => item.count > 0 && names.includes(item.name))
}

/** how many blocks of the scaffolding (`names`) the inventory holds; in creative any is as good as endless */
export function scaffoldCount (bot: Bot, names: readonly string[] = DEFAULT_SCAFFOLDING_BLOCKS): number {
  const amt = scaffoldStacks(bot, names).reduce((acc, item) => acc + item.count, 0)
  if (bot.game?.gameMode === 'creative') return amt > 0 ? Infinity : 0
  return amt
}

/** the stack a place takes: the first of `names` (cheapest first) that the inventory holds */
export function scaffoldItem (bot: Bot, names: readonly string[] = DEFAULT_SCAFFOLDING_BLOCKS): Item | null {
  const stacks = scaffoldStacks(bot, names)
  for (const name of names) {
    const stack = stacks.find((item) => item.name === name)
    if (stack != null) return stack
  }
  return null
}
