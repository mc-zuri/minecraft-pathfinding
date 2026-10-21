import { Bot } from 'mineflayer'
import type { Block } from './types'
import type { Item } from 'prismarine-item'
import * as nbt from 'prismarine-nbt'

export class PathingUtil {
  private items: Item[] = []
  private tools: Item[] = []

  private memoedDigSpeed: { [key: string]: number } = {}
  private memoedBestTool: { [key: string]: Item | null } = {}

  constructor (private readonly bot: Bot) {
    this.refresh()
  }

  public refresh (): void {
    this.items = this.bot.inventory.items()
    this.tools = PathingUtil.toolsOf(this.items)
    this.memoedDigSpeed = {}
    this.memoedBestTool = {}
  }

  private static toolsOf (items: Item[]): Item[] {
    return items.filter(
      (item) => item.name.includes('pickaxe') || item.name.includes('axe') || item.name.includes('shovel') || item.name.includes('hoe') || item.name.includes('shears')
    )
  }

  /**
   * The fastest of the tools at the block, and its dig time: none, and the hand's time, when no tool digs it faster than
   * the hand. A tool wears by each block it breaks, whatever the block (Item.mineBlock: DiggerItem's hurtAndBreak when
   * the block's destroy time is not 0), and the first tool of the bag was taken for every block no tool was faster at:
   * a bot with no shovel dug dirt and grass with its pickaxe, as fast as by hand, and wore it.
   */
  private fastestTool (block: Block, tools: Item[]): { tool: Item | null, digTime: number } {
    const effects = this.bot.entity.effects
    const creative = this.bot.game.gameMode === 'creative'
    let fastest = block.digTime(null, creative, false, false, [], effects)
    let bestTool: Item | null = null
    for (const tool of tools) {
      const enchants = tool.nbt != null ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool.type, creative, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }
    return { tool: bestTool, digTime: fastest }
  }

  /**
   * The hand for a dig by hand (no tool faster: fastestTool's none): the held item kept when it is no tool that wears,
   * else a hotbar slot that's empty or holds no such tool selected; when every hotbar slot holds one, the held tool is
   * kept. Not mineflayer's unequip('hand'): with the bag full it tosses the held stack (equipEmpty: tossStack), the
   * pickaxe thrown away for a block of dirt.
   */
  public async handForDig (): Promise<void> {
    const wears = (item: Item | null | undefined): boolean => item != null && ((item as any).maxDurability ?? 0) > 0
    if (!wears(this.bot.heldItem)) return
    const start = this.bot.inventory.hotbarStart
    let slot: number | null = null
    for (let i = 0; i < 9; i++) {
      const item = this.bot.inventory.slots[start + i]
      if (item == null) { slot = i; break }
      if (slot == null && !wears(item)) slot = i
    }
    if (slot != null) this.bot.setQuickBarSlot(slot)
  }

  /**
   * The best tool for the block among those the inventory holds now, as the item in its slot: the one a dig equips
   * (mineflayer's equip takes it by its slot). The search's memo is the inventory's at the path's start: a tool got
   * since (given, crafted, picked up) wasn't known, and a dig with none known unequipped the hand, the pickaxe held
   * put in the bag, and dug stone by hand.
   */
  public currentHarvestingTool (block: Block): Item | null {
    if (block == null) return null
    return this.fastestTool(block, PathingUtil.toolsOf(this.bot.inventory.items())).tool
  }

  /**
   * TODO: Handle underwater digging.
   */
  public bestHarvestingTool (block: Block): Item | null {
    if (block === null) return null
    const memoed = this.memoedBestTool[block.type]
    if (memoed != null) {
      // the tool as the inventory holds it now: mineflayer's equip takes an item by its slot (item.slot), and the memo's
      // was the inventory's at the path's start. A tool moved since (a hotbar slot given to the scaffolding equipped
      // from the bag, the server's set_slot of a worn tool, a stack sorted) left its old slot to something else: the
      // dig equipped that, cobblestone or a crafting table, and dug granite by hand. The slot's item while it is
      // still the tool, else the inventory's tools again.
      const live = this.bot.inventory.slots[memoed.slot]
      if (live != null && live.type === memoed.type) {
        this.memoedBestTool[block.type] = live
        return live
      }
      this.refresh()
    }

    const { tool: bestTool, digTime: fastest } = this.fastestTool(block, this.tools)

    this.memoedBestTool[block.type] = bestTool
    this.memoedDigSpeed[block.type] = fastest
    return bestTool
  }

  public digCost (block: Block): number {
    if (this.memoedDigSpeed[block.type] != null) return this.memoedDigSpeed[block.type]
    this.bestHarvestingTool(block) // run it to fill everything in.

    return this.memoedDigSpeed[block.type]
  }
}
