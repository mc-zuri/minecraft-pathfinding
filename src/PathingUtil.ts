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
    this.tools = this.items.filter(
      (item) => item.name.includes('pickaxe') || item.name.includes('axe') || item.name.includes('shovel') || item.name.includes('hoe') || item.name.includes('shears')
    )
    this.memoedDigSpeed = {}
    this.memoedBestTool = {}
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

    const availableTools = this.tools
    const effects = this.bot.entity.effects

    const creative = this.bot.game.gameMode === 'creative'

    let fastest = Number.MAX_VALUE
    let bestTool = null as unknown as Item

    // if (creative === false)
    for (const tool of availableTools) {
      const enchants = tool.nbt != null ? nbt.simplify(tool.nbt).Enchantments : []
      const digTime = block.digTime(tool.type, creative, false, false, enchants, effects)
      if (digTime < fastest) {
        fastest = digTime
        bestTool = tool
      }
    }

    // // default to no tools used in creative.
    if (fastest === Number.MAX_VALUE) {
      fastest = block.digTime(null, creative, false, false, [], effects)
    }

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
