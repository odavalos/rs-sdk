/**
 * High-level Bot Actions API
 *
 * This module provides domain-aware methods that handle game mechanics automatically.
 * Actions wait for effects to complete (not just acknowledgment from server).
 * All methods automatically dismiss blocking UI (level-up dialogs, etc.) before executing.
 *
 * All methods return result objects with { success: boolean, message?: string, ... }
 * Check result.success before continuing. On failure, result.message explains why.
 *
 * Target parameters accept NearbyNpc/NearbyLoc/InventoryItem objects, strings, or RegExp patterns.
 */

/**
 * Available methods on the bot object:
 *
 * == Movement ==
 * - walkTo(x, z, tolerance?) - Pathfind to coordinates, opens doors along the way
 *
 * == Interaction ==
 * - talkTo(target) - Walk to NPC, start dialog
 * - interactNpc(target, option?) - Walk to NPC, interact with option (e.g. 'trade', 'fish')
 * - interactLoc(target, option?) - Walk to loc, interact with option (e.g. 'mine', 'smelt')
 * - navigateDialog(choices) - Auto-click through dialog option sequence
 *
 * == Woodcutting ==
 * - chopTree(target?) - Chop a tree, wait for logs. target can be location, name pattern, or regex
 *
 * == Firemaking ==
 * - burnLogs(logsTarget?) - Burn logs on ground. If logs specified, drops them first
 *
 * == Combat ==
 * - attackNpc(target, timeout?) - Attack NPC and wait for combat to complete
 * - castSpellOnNpc(target, spellComponent, timeout?) - Cast combat spell on NPC
 * - pickpocketNpc(target) - Pickpocket NPC, detects XP gain vs stun
 * - eatFood(target) - Eat food item from inventory, returns HP gained
 *
 * == Items & Inventory ==
 * - pickupItem(target) - Pick up ground item by name/pattern
 * - equipItem(target) - Equip item from inventory
 * - unequipItem(target) - Unequip item to inventory
 * - useItemOnLoc(item, loc, options?) - Use inventory item on loc (e.g. fish on range)
 * - useItemOnNpc(item, npc, options?) - Use inventory item on NPC
 *
 * == Doors ==
 * - openDoor(target?) - Open door/gate, target can be location or pattern
 *
 * == Shopping ==
 * - openShop(target?) - Open shop by talking to shopkeeper NPC
 * - buyFromShop(target, amount?) - Buy item from open shop
 * - sellToShop(target, amount?) - Sell inventory item to open shop
 * - closeShop(timeout?) - Close open shop interface
 *
 * == Banking ==
 * - openBank(timeout?) - Open nearest bank (walks to banker if needed)
 * - depositItem(target, amount?) - Deposit item to bank (-1 for all)
 * - withdrawItem(target, amount?) - Withdraw item from bank
 * - closeBank(timeout?) - Close bank interface
 *
 * == Crafting ==
 * - smithAtAnvil(product?, options?) - Smith bars at anvil
 * - fletchLogs(product?) - Fletch logs into bows/arrows
 * - craftLeather(product?) - Craft leather at workbench
 * - craftJewelry(options?) - Craft jewelry at furnace (options: barPattern, product, gem)
 * - stringAmulet(target?, options?) - String an amulet with ball of wool
 *
 * == Magic ==
 * - castSpellOnNpc(target, spellComponent, timeout?) - Cast combat spell on NPC
 * - enchantItem(target, level, options?) - Enchant jewelry (level 1-5)
 *
 * == Prayer ==
 * - activatePrayer(prayer) - Activate a prayer by name or index
 * - deactivatePrayer(prayer) - Deactivate a prayer by name or index
 * - deactivateAllPrayers() - Deactivate all active prayers
 *
 * == Waiting ==
 * - waitForSkillLevel(skillName, targetLevel, timeout?) - Wait until skill reaches level
 * - waitForInventoryItem(pattern, timeout?) - Wait for item to appear in inventory
 * - waitForDialogClose(timeout?) - Wait for dialog to close
 * - waitForIdle(timeout?) - Wait until player is idle
 *
 * == UI ==
 * - dismissBlockingUI() - Close any blocking UI (dialogs, level-ups, etc.)
 * - skipTutorial(options?) - Navigate through tutorial island
 *
 * Example usage:
 *   const tree = sdk.findNearbyLoc(/^tree$/i);
 *   const result = await bot.chopTree(tree);
 *   if (result.success) {
 *     console.log('Got logs:', result.logs);
 *   }
 */
