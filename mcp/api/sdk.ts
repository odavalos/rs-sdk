/**
 * Low-level Bot SDK API
 *
 * This module provides direct access to the bot protocol and state queries.
 * Methods resolve when server ACKNOWLEDGES them (not when effects complete).
 * For most use cases, prefer the high-level `bot` API instead.
 *
 * All send* methods return Promise<ActionResult> with { success: boolean, message?: string }
 * State query methods return data synchronously from cached state.
 */

/**
 * Available methods on the sdk object:
 *
 * == Connection ==
 * - isConnected() - Check if WebSocket is open
 * - getConnectionState() - Get state: 'connected' | 'connecting' | 'disconnected' | 'reconnecting'
 * - getConnectionMode() - Get mode: 'control' | 'observe'
 * - getReconnectAttempt() - Get current reconnection attempt number
 * - onConnectionStateChange(callback) - Listen for connection changes (returns unsubscribe fn)
 *
 * == Bot Status ==
 * - checkBotStatus() - Check bot status via gateway HTTP endpoint
 * - isBotConnected() - Check if bot is currently connected to gateway
 *
 * == State Access (Synchronous) ==
 * - getState(): BotWorldState | null - Full state snapshot
 * - getStateAge() - Milliseconds since last state update
 * - getStateReceivedAt() - Timestamp when state was last received
 *
 * == State Queries ==
 * - getInventory(): InventoryItem[] - All inventory items
 * - getInventoryItem(slot) - Get item by slot number
 * - findInventoryItem(pattern) - Find item by name/regex
 * - getEquipment(): InventoryItem[] - All equipped items
 * - getEquipmentItem(slot) - Get equipped item by slot
 * - findEquipmentItem(pattern) - Find equipped item by name/regex
 * - getBankItems(): BankItem[] - All bank items (bank must be open)
 * - getBankItem(slot) - Get bank item by slot
 * - findBankItem(pattern) - Find bank item by name/regex
 * - isBankOpen() - Check if bank interface is open
 * - getNearbyNpcs(): NearbyNpc[] - All nearby NPCs
 * - getNearbyNpc(index) - Get NPC by index
 * - findNearbyNpc(pattern) - Find NPC by name/regex
 * - getNearbyLocs(): NearbyLoc[] - All nearby locations
 * - getNearbyLoc(x, z, id) - Get location by coords and ID
 * - findNearbyLoc(pattern) - Find location by name/regex
 * - getGroundItems(): GroundItem[] - All ground items
 * - findGroundItem(pattern) - Find ground item by name/regex
 * - getSkill(name) - Get skill by name (case-insensitive)
 * - getSkillXp(name) - Get XP for a skill
 * - getSkills(): SkillState[] - All skills
 * - getDialog(): DialogState | null - Current dialog state
 *
 * == Key Types ==
 * PlayerState: { name, combatLevel, hp, maxHp, x, z, worldX, worldZ, level (floor 0-3), runEnergy, runWeight, animId, spotanimId, combat: PlayerCombatState }
 * PlayerCombatState: { inCombat, targetIndex, lastDamageTick }
 * InventoryItem: { slot, id, name, count, optionsWithIndex }
 * NearbyNpc: { index, name, combatLevel, x, z, distance, hp, maxHp, healthPercent, inCombat, options }
 * NearbyLoc: { id, name, x, z, distance, options }
 * GroundItem: { id, name, count, x, z, distance }
 * SkillState: { name, level, baseLevel, experience }
 *
 * == On-Demand Scanning ==
 * - scanNearbyLocs(radius?) - Scan for locations with custom radius (async)
 * - scanGroundItems(radius?) - Scan for ground items on-demand (async)
 * - scanFindNearbyLoc(pattern, radius?) - Find location by name via on-demand scan
 * - scanFindGroundItem(pattern, radius?) - Find ground item by name via on-demand scan
 *
 * == Raw Actions (Promise-based, resolve on acknowledgment) ==
 * - sendWalk(x, z, running?) - Walk to coordinates
 * - sendInteractLoc(x, z, locId, option?) - Interact with location (chop tree, mine rock, etc.)
 * - sendInteractNpc(npcIndex, option?) - Interact with NPC (talk, attack, trade, etc.)
 * - sendInteractPlayer(playerIndex, option?) - Interact with player
 * - sendTalkToNpc(npcIndex) - Talk to NPC by index
 * - sendPickup(x, z, itemId) - Pick up ground item
 * - sendUseItem(slot, option?) - Use inventory item (eat, equip, etc.)
 * - sendUseEquipmentItem(slot, option?) - Use equipped item (remove, operate, etc.)
 * - sendDropItem(slot) - Drop inventory item
 * - sendUseItemOnItem(sourceSlot, targetSlot) - Use one item on another
 * - sendUseItemOnLoc(itemSlot, x, z, locId) - Use item on location
 * - sendUseItemOnNpc(itemSlot, npcIndex) - Use item on NPC
 * - sendClickDialog(option?) - Click dialog option by index
 * - sendClickComponent(componentId) - Click UI component (IF_BUTTON)
 * - sendClickComponentWithOption(componentId, optionIndex?, slot?) - Click component with option (INV_BUTTON)
 * - sendClickInterfaceOption(optionIndex) - Click interface option by index
 * - sendShopBuy(slot, amount?) - Buy from shop
 * - sendShopSell(slot, amount?) - Sell to shop
 * - sendCloseShop() - Close shop interface
 * - sendCloseModal() - Close any modal interface
 * - sendBankDeposit(slot, amount?) - Deposit item to bank
 * - sendBankWithdraw(slot, amount?) - Withdraw item from bank
 * - sendSetCombatStyle(style) - Set combat style (0-3)
 * - sendSetTab(tabIndex) - Switch UI tab
 * - sendSay(message) - Send chat message
 * - sendWait(ticks?) - Wait for game ticks
 *
 * == Spells ==
 * - sendSpellOnNpc(npcIndex, spellComponent) - Cast spell on NPC
 * - sendSpellOnItem(slot, spellComponent) - Cast spell on inventory item
 * - sendSpellOnGroundItem(x, z, itemId, spellComponent) - Cast spell on ground item
 *
 * == Prayer ==
 * - sendTogglePrayer(prayer) - Toggle prayer on/off by name or index (0-14)
 * - getPrayerState() - Get current prayer state
 * - isPrayerActive(prayer) - Check if prayer is active
 * - getActivePrayers() - Get list of active prayer names
 *
 * == Pathfinding ==
 * - findPath(destX, destZ, maxWaypoints?) - Find path from current position using local collision data
 * - sendFindPath(destX, destZ, maxWaypoints?) - Async alias for findPath
 *
 * == Screenshots ==
 * - sendScreenshot(timeout?) - Request screenshot from bot client (returns base64 data URL)
 *
 * == Waiting ==
 * - waitForCondition(predicate, timeout?) - Wait for state to match predicate
 * - waitForStateChange(timeout?) - Wait for next state update
 * - waitForStateUpdate() - Wait for next state update (5s timeout)
 * - waitForTicks(ticks?) - Wait for N game ticks (~300ms each)
 * - waitForReady(timeout?) - Wait for game state to be fully loaded
 * - waitForConnection(timeout?) - Wait for WebSocket connection
 * - waitForBotConnection(timeout?) - Wait for bot to connect to gateway
 *
 * == Listeners ==
 * - onStateUpdate(callback) - Register listener for state updates (returns unsubscribe fn)
 * - onConnectionStateChange(callback) - Register listener for connection changes
 *
 * Example usage:
 *   const state = sdk.getState();
 *   console.log('Position:', state.player.worldX, state.player.worldZ);
 *
 *   const tree = sdk.findNearbyLoc(/^tree$/i);
 *   if (tree) {
 *     const result = await sdk.sendInteractLoc(tree.x, tree.z, tree.id, 0);
 *     console.log('Chop result:', result);
 *   }
 */
