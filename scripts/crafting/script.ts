/**
 * Crafting Training Script
 *
 * Goal: Train Crafting from level 1 to level 10+ starting from Lumbridge spawn.
 *
 * Strategy:
 * 1. Sell shortbow at general store to get coins
 * 2. Collect cowhides from cow field
 * 3. Travel to Al Kharid (pay toll)
 * 4. Buy needle + thread from craft shop
 * 5. Tan hides at Ellis
 * 6. Craft leather items
 * 7. Repeat as needed
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc } from '../../sdk/types';

// Locations
const LOCATIONS = {
    LUMBRIDGE_GENERAL_STORE: { x: 3211, z: 3247 },
    COW_FIELD: { x: 3253, z: 3270 },
    TOLL_GATE: { x: 3268, z: 3228 },
    INSIDE_AL_KHARID: { x: 3277, z: 3227 },
    // Dommik's Crafting Store - trying multiple locations
    // Standard OSRS location should be around (3321, 3179) - east of general store
    AL_KHARID_CRAFT_SHOP: { x: 3321, z: 3179 },
    AL_KHARID_TANNER: { x: 3274, z: 3192 },
    AL_KHARID_BANK: { x: 3269, z: 3167 },
};

// Configuration
// Note: Server has tick freeze issues during extended combat (known bug)
// Using small batches (2 hides) for speed
const HIDES_PER_TRIP = 2;  // Collect this many hides before crafting
const TARGET_LEVEL = 10;

// Stats tracking
interface CraftingStats {
    hidesCollected: number;
    hidesTanned: number;
    itemsCrafted: number;
    xpGained: number;
    startTime: number;
}

// ============ Helper Functions ============

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.sdk.findInventoryItem(/^coins$/i);
    return coins?.count ?? 0;
}

function getHideCount(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.inventory.filter(i => /cow\s*hide/i.test(i.name))
        .reduce((sum, i) => sum + i.count, 0) ?? 0;
}

function getLeatherCount(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.inventory.filter(i => /^leather$/i.test(i.name))
        .reduce((sum, i) => sum + i.count, 0) ?? 0;
}

function getCraftingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Crafting')?.baseLevel ?? 1;
}

function getCraftingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Crafting')?.experience ?? 0;
}

function isInsideAlKharid(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state?.player) return false;
    return state.player.worldX >= 3270;
}

function hasNeedle(ctx: ScriptContext): boolean {
    return ctx.sdk.findInventoryItem(/needle/i) !== null;
}

function hasThread(ctx: ScriptContext): boolean {
    return ctx.sdk.findInventoryItem(/thread/i) !== null;
}

async function dismissDialogs(ctx: ScriptContext, stats: CraftingStats): Promise<void> {
    while (ctx.sdk.getState()?.dialog.isOpen) {
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
    }
}

// ============ Phase 1: Get Initial Coins ============

async function getInitialCoins(ctx: ScriptContext, stats: CraftingStats): Promise<void> {
    if (getCoins(ctx) >= 30) {
        console.log(`Already have ${getCoins(ctx)}gp`);
        return;
    }

    console.log('Phase 1: Getting coins from general store...');

    // Walk to general store
    await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_GENERAL_STORE.x, LOCATIONS.LUMBRIDGE_GENERAL_STORE.z);

    // Open shop
    const openResult = await ctx.bot.openShop(/shop keeper/i);
    if (!openResult.success) {
        console.warn(`Failed to open shop: ${openResult.message}`);
        return;
    }
    console.log('Shop opened');

    // Sell shortbow (worth ~20gp)
    const sellResult = await ctx.bot.sellToShop(/shortbow/i, 'all');
    if (sellResult.success) {
        console.log(sellResult.message);
    }

    // Close shop
    await ctx.bot.closeShop();

    console.log(`Have ${getCoins(ctx)}gp after selling`);
}

// ============ Phase 2: Collect Cowhides ============

function findBestCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(o => /attack/i.test(o)))
        .filter(npc => !npc.inCombat || npc.targetIndex === -1)
        .sort((a, b) => a.distance - b.distance);

    return cows[0] ?? null;
}

async function waitForCombatEnd(
    ctx: ScriptContext,
    targetNpc: NearbyNpc,
    stats: CraftingStats
): Promise<'kill' | 'fled' | 'lost_target'> {
    let combatStarted = false;
    let ticksSinceCombatEnded = 0;
    let loopCount = 0;

    const maxWaitMs = 30000;
    const startTime = Date.now();

    await new Promise(r => setTimeout(r, 800));

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, 400));
        loopCount++;
        const state = ctx.sdk.getState();
        if (!state) return 'lost_target';

        // Dismiss level-up dialogs
        if (state.dialog.isOpen) {
            console.log('Dismissing dialog during combat...');
            await ctx.sdk.sendClickDialog(0);
            continue;
        }

        const currentTick = state.tick;
        const target = state.nearbyNpcs.find(n => n.index === targetNpc.index);

        if (!target) {
            if (combatStarted || loopCount >= 2) {
                return 'kill';
            }
            return 'lost_target';
        }

        if (target.maxHp > 0 && target.hp === 0) {
            return 'kill';
        }

        const npcInCombat = target.combatCycle > currentTick;
        const playerInCombat = state.player?.combat?.inCombat ?? false;
        const inActiveCombat = playerInCombat || npcInCombat;

        if (inActiveCombat) {
            combatStarted = true;
            ticksSinceCombatEnded = 0;
        } else if (combatStarted) {
            ticksSinceCombatEnded++;
            if (ticksSinceCombatEnded >= 4) {
                return 'fled';
            }
        } else if (loopCount >= 8) {
            return 'lost_target';
        }
    }

    return 'lost_target';
}

async function collectCowhides(ctx: ScriptContext, stats: CraftingStats, targetHides: number): Promise<void> {
    console.log(`Phase 2: Collecting ${targetHides} cowhides...`);

    // Equip combat gear
    const sword = ctx.sdk.findInventoryItem(/bronze sword/i);
    if (sword) {
        await ctx.bot.equipItem(sword);
    }

    const shield = ctx.sdk.findInventoryItem(/wooden shield/i);
    if (shield) {
        await ctx.bot.equipItem(shield);
    }

    // Walk to cow field
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);

    while (getHideCount(ctx) < targetHides) {
        const state = ctx.sdk.getState();
        if (!state) break;

        // Check inventory space
        if (state.inventory.length >= 28) {
            console.log('Inventory full, stopping collection');
            break;
        }

        // Dismiss dialogs
        await dismissDialogs(ctx, stats);

        // Pick up nearby hides
        const groundHides = ctx.sdk.getGroundItems()
            .filter(i => /cow\s*hide/i.test(i.name))
            .filter(i => i.distance <= 8)
            .sort((a, b) => a.distance - b.distance);

        for (const hide of groundHides.slice(0, 2)) {
            if (ctx.sdk.getState()!.inventory.length >= 28) break;
            const result = await ctx.bot.pickupItem(hide);
            if (result.success) {
                stats.hidesCollected++;
                console.log(`Picked up hide (total: ${getHideCount(ctx)})`);
            }
        }

        // Find cow to kill
        const cow = findBestCow(ctx);
        if (!cow) {
            console.log('No cows nearby, walking around...');
            await ctx.bot.walkTo(
                LOCATIONS.COW_FIELD.x + (Math.random() - 0.5) * 20,
                LOCATIONS.COW_FIELD.z + (Math.random() - 0.5) * 20
            );
            continue;
        }

        // Check if already in combat
        const playerCombat = state.player?.combat;
        if (playerCombat?.inCombat) {
            await waitForCombatEnd(ctx, cow, stats);
            continue;
        }

        // Attack cow
        const attackResult = await ctx.bot.attackNpc(cow);
        if (!attackResult.success) {
            if (attackResult.reason === 'out_of_reach') {
                const gateResult = await ctx.bot.openDoor(/gate/i);
                if (gateResult.success) {
                    console.log('Opened gate');
                }
            }
            continue;
        }

        // Wait for kill
        const combatResult = await waitForCombatEnd(ctx, cow, stats);
        if (combatResult === 'kill') {
            console.log(`Kill! Hides: ${getHideCount(ctx)}`);
            await new Promise(r => setTimeout(r, 600));
        }
    }

    console.log(`Collected ${getHideCount(ctx)} hides`);
}

// ============ Phase 3: Travel to Al Kharid ============

// Check if player is in the cow field area (fenced area)
function isInCowField(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state?.player) return false;
    const x = state.player.worldX;
    const z = state.player.worldZ;
    // Cow field is roughly (3242-3265, 3255-3298) - inside the fenced area
    return x >= 3242 && x <= 3265 && z >= 3255 && z <= 3298;
}

async function exitCowField(ctx: ScriptContext, stats: CraftingStats): Promise<boolean> {
    console.log('Exiting cow field...');

    // The cow field gate is on the south side around (3253, 3255)
    // Try to find and open any nearby gate
    for (let attempt = 0; attempt < 5; attempt++) {
        // Look for a gate
        const gate = ctx.sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name) && l.distance < 10);

        if (gate) {
            const openOpt = gate.optionsWithIndex.find(o => /open/i.test(o.text));
            if (openOpt) {
                console.log(`Opening cow field gate at (${gate.x}, ${gate.z})`);
                await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
                await new Promise(r => setTimeout(r, 800));
            }
        }

        // Walk towards the exit point just south of the cow field
        const result = await ctx.bot.walkTo(3253, 3250);
        if (result.success && !isInCowField(ctx)) {
            console.log('Exited cow field');
            return true;
        }

        // If we're not making progress, try opening door
        if (!result.success) {
            const doorResult = await ctx.bot.openDoor(/gate/i);
            if (doorResult.success) {
                console.log('Opened gate via openDoor');
            }
        }
    }

    return !isInCowField(ctx);
}

async function travelToAlKharid(ctx: ScriptContext, stats: CraftingStats): Promise<boolean> {
    if (isInsideAlKharid(ctx)) {
        console.log('Already in Al Kharid');
        return true;
    }

    console.log('Phase 3: Traveling to Al Kharid...');

    if (getCoins(ctx) < 10) {
        console.warn(`Not enough coins for toll (have ${getCoins(ctx)})`);
        return false;
    }

    // First, exit the cow field if we're in it
    if (isInCowField(ctx)) {
        const exited = await exitCowField(ctx, stats);
        if (!exited) {
            console.warn('Could not exit cow field');
            return false;
        }
    }

    // Walk to gate - make sure we're at the correct position
    console.log(`Walking to toll gate from (${ctx.sdk.getState()?.player?.worldX}, ${ctx.sdk.getState()?.player?.worldZ})`);
    await ctx.bot.walkTo(LOCATIONS.TOLL_GATE.x, LOCATIONS.TOLL_GATE.z);
    await new Promise(r => setTimeout(r, 1000));  // Wait for pathfinding

    // Find and interact with gate
    let gate = ctx.sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name) && l.distance < 15);

    // If gate not found, try walking closer to known toll gate position
    if (!gate) {
        console.log('Gate not found, walking to exact toll gate position...');
        await ctx.bot.walkTo(3267, 3228);  // Exact toll gate position
        await new Promise(r => setTimeout(r, 1000));
        gate = ctx.sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name) && l.distance < 15);
    }
    if (!gate) {
        console.warn('No gate found');
        return false;
    }

    const openOpt = gate.optionsWithIndex.find(o => /pay|open/i.test(o.text));
    if (!openOpt) {
        console.warn('No open/pay option on gate');
        return false;
    }

    // Click gate to trigger dialog
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
    await new Promise(r => setTimeout(r, 800));

    // Handle toll dialog
    let paidToll = false;
    for (let i = 0; i < 20 && !paidToll; i++) {
        const s = ctx.sdk.getState();
        if (!s?.dialog.isOpen) {
            await new Promise(r => setTimeout(r, 150));
            continue;
        }

        const yesOpt = s.dialog.options.find(o => /yes/i.test(o.text));
        if (yesOpt) {
            console.log('Paying toll...');
            await ctx.sdk.sendClickDialog(yesOpt.index);
            paidToll = true;
        } else {
            await ctx.sdk.sendClickDialog(0);
        }
        await new Promise(r => setTimeout(r, 200));
    }

    // Wait and dismiss remaining dialogs
    await new Promise(r => setTimeout(r, 500));
    await dismissDialogs(ctx, stats);

    // Walk through
    for (let i = 0; i < 3; i++) {
        await ctx.bot.walkTo(LOCATIONS.INSIDE_AL_KHARID.x, LOCATIONS.INSIDE_AL_KHARID.z);
        await new Promise(r => setTimeout(r, 500));
        if (isInsideAlKharid(ctx)) break;
    }

    const success = isInsideAlKharid(ctx);
    console.log(success ? 'Arrived in Al Kharid!' : 'Failed to enter Al Kharid');
    return success;
}

// ============ Phase 4: Buy Crafting Supplies ============

async function buyCraftingSupplies(ctx: ScriptContext, stats: CraftingStats): Promise<boolean> {
    if (hasNeedle(ctx) && hasThread(ctx)) {
        console.log('Already have needle and thread');
        return true;
    }

    console.log('Phase 4: Buying crafting supplies...');

    // Walk to craft shop
    await ctx.bot.walkTo(LOCATIONS.AL_KHARID_CRAFT_SHOP.x, LOCATIONS.AL_KHARID_CRAFT_SHOP.z);

    // Log player position for debugging
    const pos = ctx.sdk.getState()?.player;
    console.log(`Player at: (${pos?.worldX}, ${pos?.worldZ})`);

    // Log all nearby NPCs to find Dommik
    const allNpcs = ctx.sdk.getState()?.nearbyNpcs || [];
    console.log(`All NPCs nearby (${allNpcs.length}): ${allNpcs.slice(0, 15).map(n => `${n.name}(${n.distance})`).join(', ')}`);

    // Find Dommik the crafting shop owner
    let shopkeeper = ctx.sdk.findNearbyNpc(/^dommik$/i);
    if (!shopkeeper) {
        // Try broader search
        shopkeeper = ctx.sdk.findNearbyNpc(/craft/i);
    }
    if (!shopkeeper) {
        // Dommik might not be loaded yet - try walking around to find more NPCs
        console.log('Dommik not found, searching nearby...');

        // Try walking to different spots in the area
        const searchSpots = [
            { x: 3321, z: 3179 },
            { x: 3316, z: 3175 },
            { x: 3325, z: 3180 },
            { x: 3318, z: 3183 },
        ];

        for (const spot of searchSpots) {
            await ctx.bot.walkTo(spot.x, spot.z);
            await new Promise(r => setTimeout(r, 500));

            shopkeeper = ctx.sdk.findNearbyNpc(/^dommik$/i);
            if (shopkeeper) {
                console.log(`Found Dommik at spot (${spot.x}, ${spot.z})`);
                break;
            }

            const npcs = ctx.sdk.getState()?.nearbyNpcs.slice(0, 10).map(n => `${n.name}(${n.distance})`).join(', ') ?? 'none';
            console.log(`At (${spot.x}, ${spot.z}): NPCs = ${npcs}`);
        }
    }

    if (!shopkeeper) {
        console.warn(`Could not find Dommik after searching`);
        return false;
    }

    console.log(`Found shopkeeper: ${shopkeeper.name} at distance ${shopkeeper.distance}`);

    // Open shop using Trade option
    const tradeOpt = shopkeeper.optionsWithIndex.find(o => /trade/i.test(o.text));
    if (!tradeOpt) {
        console.warn(`No trade option on Dommik. Options: ${shopkeeper.options.join(', ')}`);
        return false;
    }

    console.log(`Trading with Dommik (distance: ${shopkeeper.distance})...`);
    await ctx.sdk.sendInteractNpc(shopkeeper.index, tradeOpt.opIndex);

    // Wait for shop to open (longer wait - interaction will walk us closer)
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));

        // Check for shop opening
        if (ctx.sdk.getState()?.shop.isOpen) break;

        // If dialog opened instead (Talk-to triggered), dismiss it
        if (ctx.sdk.getState()?.dialog.isOpen) {
            console.log('Dialog opened, clicking through...');
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 200));
        }
    }

    if (!ctx.sdk.getState()?.shop.isOpen) {
        // Maybe we need to open a door first?
        const door = ctx.sdk.getState()?.nearbyLocs.find(l => /door/i.test(l.name) && l.distance < 5);
        if (door) {
            console.log('Trying to open door...');
            const openOpt = door.optionsWithIndex.find(o => /open/i.test(o.text));
            if (openOpt) {
                await ctx.sdk.sendInteractLoc(door.x, door.z, door.id, openOpt.opIndex);
                await new Promise(r => setTimeout(r, 1000));

                // Try trading again
                const newShopkeeper = ctx.sdk.findNearbyNpc(/^dommik$/i);
                if (newShopkeeper) {
                    const newTradeOpt = newShopkeeper.optionsWithIndex.find(o => /trade/i.test(o.text));
                    if (newTradeOpt) {
                        await ctx.sdk.sendInteractNpc(newShopkeeper.index, newTradeOpt.opIndex);
                        for (let i = 0; i < 30; i++) {
                            await new Promise(r => setTimeout(r, 200));
                            if (ctx.sdk.getState()?.shop.isOpen) break;
                        }
                    }
                }
            }
        }
    }

    if (!ctx.sdk.getState()?.shop.isOpen) {
        console.warn('Shop still did not open');
        return false;
    }

    console.log(`Shop opened: ${ctx.sdk.getState()?.shop.title}`);

    // Buy needle if needed
    if (!hasNeedle(ctx)) {
        const buyResult = await ctx.bot.buyFromShop(/needle/i, 1);
        console.log(buyResult.success ? 'Bought needle' : `Failed to buy needle: ${buyResult.message}`);
    }

    // Buy thread if needed
    if (!hasThread(ctx)) {
        const buyResult = await ctx.bot.buyFromShop(/thread/i, 5);
        console.log(buyResult.success ? 'Bought thread' : `Failed to buy thread: ${buyResult.message}`);
    }

    await ctx.bot.closeShop();

    return hasNeedle(ctx) && hasThread(ctx);
}

// ============ Phase 5: Tan Hides ============

async function tanHides(ctx: ScriptContext, stats: CraftingStats): Promise<void> {
    const hideCount = getHideCount(ctx);
    if (hideCount === 0) {
        console.log('No hides to tan');
        return;
    }

    console.log(`Phase 5: Tanning ${hideCount} hides...`);

    // Walk to tanner
    await ctx.bot.walkTo(LOCATIONS.AL_KHARID_TANNER.x, LOCATIONS.AL_KHARID_TANNER.z);

    // Find the tanner
    const tanner = ctx.sdk.findNearbyNpc(/^tanner$/i);
    if (!tanner) {
        const npcs = ctx.sdk.getState()?.nearbyNpcs.slice(0, 5).map(n => `${n.name}(${n.options.join('/')})`).join(', ') ?? 'none';
        console.warn(`No tanner found. Nearby NPCs: ${npcs}`);
        return;
    }

    console.log(`Found tanner: ${tanner.name} at distance ${tanner.distance}, options: ${tanner.options.join(', ')}`);

    // Talk to the tanner (uses Talk-to, not Trade)
    const talkOpt = tanner.optionsWithIndex.find(o => /talk/i.test(o.text));
    if (!talkOpt) {
        console.warn('No talk option on tanner');
        return;
    }

    console.log('Talking to tanner...');
    await ctx.sdk.sendInteractNpc(tanner.index, talkOpt.opIndex);

    // Wait for dialog - game will auto-walk if needed
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 200));
        if (ctx.sdk.getState()?.dialog?.isOpen) break;
    }

    if (!ctx.sdk.getState()?.dialog?.isOpen) {
        console.warn('Dialog did not open with tanner');
        // Log current state
        const player = ctx.sdk.getState()?.player;
        console.log(`Player at (${player?.worldX}, ${player?.worldZ})`);
        return;
    }

    console.log('Tanner dialog opened!');

    // Handle dialog - need to:
    // 1. Click through initial greeting
    // 2. Say "Yes please" when asked about tanning hides
    // 3. Select "Soft leather" option
    for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 400));

        const s = ctx.sdk.getState();
        if (!s?.dialog?.isOpen) {
            // Dialog closed - tanning should be complete
            console.log('Dialog closed');
            break;
        }

        const options = s.dialog.options;
        const optText = options.map(o => o.text).join(' | ');
        console.log(`Dialog options: ${optText}`);

        // Look for "Soft leather" option first (this is what we want)
        const softLeatherOpt = options.find(o => /soft leather/i.test(o.text));
        if (softLeatherOpt) {
            console.log('Selecting "Soft leather"');
            await ctx.sdk.sendClickDialog(softLeatherOpt.index);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Look for "Yes please" to confirm tanning
        const yesOpt = options.find(o => /yes.*please/i.test(o.text));
        if (yesOpt) {
            console.log('Clicking "Yes please"');
            await ctx.sdk.sendClickDialog(yesOpt.index);
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // If just "Click here to continue", click it
        if (options.length === 1 && /continue/i.test(options[0]!.text)) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Default - click option 0
        await ctx.sdk.sendClickDialog(0);
    }

    // Wait for tanning to complete
    await new Promise(r => setTimeout(r, 500));

    const leather = getLeatherCount(ctx);
    const hidesLeft = getHideCount(ctx);
    stats.hidesTanned += leather;
    console.log(`Tanning complete. Leather: ${leather}, Hides remaining: ${hidesLeft}`);
}

// ============ Phase 6: Craft Leather Items ============

async function craftLeatherItems(ctx: ScriptContext, stats: CraftingStats): Promise<void> {
    const leatherCount = getLeatherCount(ctx);
    if (leatherCount === 0) {
        console.log('No leather to craft');
        return;
    }

    console.log(`Phase 6: Crafting with ${leatherCount} leather...`);

    const xpBefore = getCraftingXp(ctx);

    // Craft all leather using the porcelain function
    while (getLeatherCount(ctx) > 0) {
        const result = await ctx.bot.craftLeather('gloves');

        if (result.success) {
            console.log(`${result.message}`);
            stats.itemsCrafted += result.itemsCrafted ?? 1;
            stats.xpGained += result.xpGained ?? 0;
        } else {
            console.warn(`Craft failed: ${result.message} (reason: ${result.reason})`);

            // If level too low, we can't craft anything
            if (result.reason === 'level_too_low') {
                break;
            }

            // If interface didn't open, the game might be stuck - try again
            if (result.reason === 'interface_not_opened') {
                await dismissDialogs(ctx, stats);
                continue;
            }

            // If no materials, stop
            if (result.reason === 'no_leather' || result.reason === 'no_needle' || result.reason === 'no_thread') {
                break;
            }

            // Timeout or no XP gained - try again once
            if (result.reason === 'timeout' || result.reason === 'no_xp_gained') {
                await dismissDialogs(ctx, stats);
                // Try one more time then give up
                const retry = await ctx.bot.craftLeather('gloves');
                if (!retry.success) {
                    console.warn(`Retry also failed: ${retry.message}`);
                    break;
                }
                console.log(`Retry succeeded: ${retry.message}`);
                stats.itemsCrafted += retry.itemsCrafted ?? 1;
                stats.xpGained += retry.xpGained ?? 0;
            }
        }

        // Dismiss any level-up dialogs between crafts
        await dismissDialogs(ctx, stats);
    }

    const totalXpGained = getCraftingXp(ctx) - xpBefore;
    console.log(`Crafting complete. Total: +${totalXpGained} XP. Level: ${getCraftingLevel(ctx)}`);
}

// ============ Phase 7: Bank and Repeat ============

async function bankItems(ctx: ScriptContext, stats: CraftingStats): Promise<void> {
    console.log('Banking items...');

    await ctx.bot.walkTo(LOCATIONS.AL_KHARID_BANK.x, LOCATIONS.AL_KHARID_BANK.z);

    const openResult = await ctx.bot.openBank();
    if (!openResult.success) {
        console.warn(`Failed to open bank: ${openResult.message}`);
        return;
    }

    // Deposit crafted items (leather gloves, etc.)
    const craftedItems = ctx.sdk.getState()?.inventory.filter(i =>
        /gloves|boots|vamb|chaps|body|cowl/i.test(i.name) && /leather/i.test(i.name)
    ) ?? [];

    for (const item of craftedItems) {
        await ctx.sdk.sendBankDeposit(item.slot, item.count);
        await new Promise(r => setTimeout(r, 150));
    }

    await ctx.bot.closeBank();
}

// ============ Main Loop ============

async function craftingLoop(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) throw new Error('No initial state');

    const stats: CraftingStats = {
        hidesCollected: 0,
        hidesTanned: 0,
        itemsCrafted: 0,
        xpGained: 0,
        startTime: Date.now(),
    };

    console.log('=== Crafting Training Script ===');
    console.log(`Starting level: ${getCraftingLevel(ctx)}`);
    console.log(`Target level: ${TARGET_LEVEL}`);
    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);

    // Get initial coins
    await getInitialCoins(ctx, stats);

    let cycle = 0;
    while (getCraftingLevel(ctx) < TARGET_LEVEL) {
        cycle++;
        console.log(`\n=== Cycle ${cycle} ===`);
        console.log(`Level: ${getCraftingLevel(ctx)}, XP: ${getCraftingXp(ctx)}`);

        // Collect hides if we don't have enough
        if (getHideCount(ctx) < HIDES_PER_TRIP && !isInsideAlKharid(ctx)) {
            await collectCowhides(ctx, stats, HIDES_PER_TRIP);
        }

        // Travel to Al Kharid if not there
        if (!isInsideAlKharid(ctx)) {
            const success = await travelToAlKharid(ctx, stats);
            if (!success) {
                throw new Error('Could not travel to Al Kharid');
            }
        }

        // Buy supplies if needed
        if (!hasNeedle(ctx) || !hasThread(ctx)) {
            const success = await buyCraftingSupplies(ctx, stats);
            if (!success) {
                throw new Error('Could not buy crafting supplies');
            }
        }

        // Tan hides
        if (getHideCount(ctx) > 0) {
            await tanHides(ctx, stats);
        }

        // Craft items
        if (getLeatherCount(ctx) > 0) {
            await craftLeatherItems(ctx, stats);
        }

        // Bank crafted items if inventory is getting full
        if (ctx.sdk.getState()!.inventory.length >= 25) {
            await bankItems(ctx, stats);
        }

        // If we've used all materials and still need more levels, go get more hides
        if (getHideCount(ctx) === 0 && getLeatherCount(ctx) === 0 && getCraftingLevel(ctx) < TARGET_LEVEL) {
            console.log('Need more hides, returning to Lumbridge...');
            // Walk back towards Lumbridge (toll gate is free to exit)
            await ctx.bot.walkTo(LOCATIONS.TOLL_GATE.x, LOCATIONS.TOLL_GATE.z);
            // Walk to Lumbridge side
            await ctx.bot.walkTo(3260, 3228);
        }
    }

    // Final stats
    const duration = (Date.now() - stats.startTime) / 1000;
    console.log('\n=== Final Results ===');
    console.log(`Duration: ${Math.round(duration)}s`);
    console.log(`Hides collected: ${stats.hidesCollected}`);
    console.log(`Hides tanned: ${stats.hidesTanned}`);
    console.log(`Items crafted: ${stats.itemsCrafted}`);
    console.log(`XP gained: ${stats.xpGained}`);
    console.log(`Final level: ${getCraftingLevel(ctx)}`);
}

// Main script
async function main() {
    // Create fresh account
    const username = `cr${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            try {
                await craftingLoop(ctx);
            } catch (e) {
                console.error(`Script aborted: ${e instanceof Error ? e.message : String(e)}`);
                throw e;
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 30 * 60 * 1000,  // 30 minutes (leather crafting takes time)
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
