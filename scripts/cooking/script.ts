/**
 * Cooking Trainer Script
 *
 * Goal: Train Cooking from level 1 to 10+
 *
 * Strategy (v3 - Al-Kharid with toll gate):
 * - Start at Lumbridge Castle with fishing net, tinderbox, axe, shortbow
 * - Sell shortbow at Lumbridge general store for 20gp
 * - Walk to Al-Kharid toll gate and pay 10gp
 * - Fish at Al-Kharid fishing spot (safe area)
 * - Cook at Al-Kharid range
 * - Repeat until level 10
 *
 * This avoids the dangerous Dark Wizard area near Draynor.
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc, NearbyLoc, InventoryItem } from '../../sdk/types';

// Key locations
const LOCATIONS = {
    LUMBRIDGE_SHOP: { x: 3212, z: 3247 },     // General store
    TOLL_GATE: { x: 3268, z: 3228 },          // Al-Kharid toll gate
    ALKHARID_FISHING: { x: 3265, z: 3153 },   // Shrimp fishing - moved north away from scorpions
    ALKHARID_RANGE: { x: 3273, z: 3180 },     // Range for cooking
};

interface Stats {
    fishCaught: number;
    fishCooked: number;
    fishBurnt: number;
    cycles: number;
    startCookingXp: number;
    startTime: number;
    lastProgressTime: number;
}

// ============ Helper Functions ============

function getCookingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Cooking')?.experience ?? 0;
}

function getCookingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Cooking')?.baseLevel ?? 1;
}

function getPlayerPos(ctx: ScriptContext): { x: number; z: number } | null {
    const state = ctx.sdk.getState();
    if (!state?.player) return null;
    return { x: state.player.worldX, z: state.player.worldZ };
}

function distanceTo(ctx: ScriptContext, target: { x: number; z: number }): number {
    const pos = getPlayerPos(ctx);
    if (!pos) return 999;
    return Math.abs(pos.x - target.x) + Math.abs(pos.z - target.z);
}

/**
 * Find the nearest fishing spot with Net option
 */
function findFishingSpot(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    // Find any fishing spot with "Net" option
    const spots = state.nearbyNpcs
        .filter(npc => /fishing\s*spot/i.test(npc.name))
        .filter(npc => npc.options.some(opt => /^net$/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    return spots[0] ?? null;
}

/**
 * Count raw fish in inventory
 */
function countRawFish(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;

    return state.inventory
        .filter(item => /^raw\s/i.test(item.name))
        .reduce((sum, item) => sum + item.count, 0);
}

/**
 * Get all raw fish items in inventory
 */
function getRawFishItems(ctx: ScriptContext): InventoryItem[] {
    const state = ctx.sdk.getState();
    if (!state) return [];

    return state.inventory.filter(item => /^raw\s/i.test(item.name));
}

/**
 * Get available slots (keeping essential items: net, tinderbox, axe)
 */
function getAvailableSlots(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;
    return 28 - state.inventory.length;
}

/**
 * Get current HP
 */
function getCurrentHp(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 10;
    return state.skills.find(s => s.name === 'Hitpoints')?.level ?? 10;
}

/**
 * Eat food if HP is low, or run away if no food
 */
async function eatIfLowHp(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    const state = ctx.sdk.getState();
    if (!state) return false;

    // Get current HP from Hitpoints skill level (it reflects current HP, not just max)
    const hitpointsSkill = state.skills.find(s => s.name === 'Hitpoints');
    const hp = hitpointsSkill?.level ?? 10;
    if (hp > 5) return false;  // HP is fine

    // Find food to eat (cooked shrimps, bread, or cooked anchovies)
    const food = state.inventory.find(i =>
        (/shrimps/i.test(i.name) && !/^raw\s/i.test(i.name)) ||
        /bread/i.test(i.name) ||
        (/anchov/i.test(i.name) && !/^raw\s/i.test(i.name))
    );

    if (!food) {
        // No food - run away from combat!
        if (hp <= 3) {
            console.log(`HP critical (${hp}), running away!`);
            // Run north towards bank (safer area)
            await ctx.sdk.sendWalk(LOCATIONS.ALKHARID_RANGE.x, LOCATIONS.ALKHARID_RANGE.z, true);
            await new Promise(r => setTimeout(r, 2000));
        }
        return false;
    }

    console.log(`HP low (${hp}), eating ${food.name}`);
    await ctx.sdk.sendUseItem(food.slot, 1);  // Option 1 = "Eat"
    await new Promise(r => setTimeout(r, 500));
    return true;
}

/**
 * Dismiss dialogs (level-up notifications, etc.)
 */
async function dismissDialogs(ctx: ScriptContext, stats: Stats, maxCount: number = 3): Promise<number> {
    let dismissed = 0;
    while (ctx.sdk.getState()?.dialog.isOpen && dismissed < maxCount) {
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
        dismissed++;
    }
    return dismissed;
}

/**
 * Walk to a position with pathfinding (with retries)
 */
async function walkToPosition(ctx: ScriptContext, stats: Stats, target: { x: number; z: number }, name: string): Promise<boolean> {
    const startDist = distanceTo(ctx, target);
    console.log(`Walking to ${name} (${target.x}, ${target.z}), dist: ${startDist}...`);

    // Use pathfinding for long distances - retry up to 3 times
    for (let attempt = 0; attempt < 3; attempt++) {
        const currentDist = distanceTo(ctx, target);
        if (currentDist <= 10) {
            console.log(`Arrived at ${name}`);
            return true;
        }

        if (currentDist > 20) {
            console.log(`Pathfinding attempt ${attempt + 1}, dist: ${currentDist}`);
            try {
                await ctx.bot.walkTo(target.x, target.z);
            } catch (e) {
                console.warn(`Pathfinding error: ${e}`);
            }
        }
    }

    // Final check
    let finalDist = distanceTo(ctx, target);
    if (finalDist <= 10) {
        console.log(`Arrived at ${name}`);
        return true;
    }

    // Direct walking for remaining distance
    console.log(`Direct walking to finish, dist: ${finalDist}`);
    await ctx.sdk.sendWalk(target.x, target.z, true);

    // Wait to arrive
    for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 400));

        await dismissDialogs(ctx, stats, 1);

        const dist = distanceTo(ctx, target);
        if (dist <= 5) {
            console.log(`Arrived at ${name}`);
            return true;
        }

        // Re-send walk periodically
        if (i > 0 && i % 10 === 0) {
            ctx.sdk.sendWalk(target.x, target.z, true);
        }
    }

    console.warn(`Failed to reach ${name} (dist: ${distanceTo(ctx, target)})`);
    return false;
}

// ============ Main Phases ============

/**
 * Phase 0a: Sell shortbow at Lumbridge general store for coins
 */
async function sellShortbowForCoins(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    // Check if we already have coins
    const coins = ctx.sdk.getState()?.inventory.find(i => /coins/i.test(i.name));
    if (coins && coins.count >= 10) {
        console.log(`Already have ${coins.count} coins`);
        return true;
    }

    // Check if we have shortbow to sell
    const shortbow = ctx.sdk.getState()?.inventory.find(i => /shortbow/i.test(i.name));
    if (!shortbow) {
        console.warn('No shortbow to sell');
        return false;
    }

    console.log('Walking to Lumbridge general store...');
    if (!await walkToPosition(ctx, stats, LOCATIONS.LUMBRIDGE_SHOP, 'Lumbridge shop')) {
        console.warn('Could not reach shop');
        return false;
    }

    // Open shop
    console.log('Opening shop...');
    const result = await ctx.bot.openShop(/shop\s*keeper/i);
    if (!result.success) {
        console.warn(`Failed to open shop: ${result.message}`);
        return false;
    }

    // Sell shortbow
    console.log('Selling shortbow...');
    const sellResult = await ctx.bot.sellToShop(/shortbow/i);
    if (!sellResult.success) {
        console.warn(`Failed to sell shortbow: ${sellResult.message}`);
    }

    // Close shop
    await ctx.bot.closeShop();
    await new Promise(r => setTimeout(r, 500));

    const newCoins = ctx.sdk.getState()?.inventory.find(i => /coins/i.test(i.name));
    console.log(`Now have ${newCoins?.count ?? 0} coins`);
    return (newCoins?.count ?? 0) >= 10;
}

/**
 * Phase 0b: Pass through Al-Kharid toll gate
 */
async function passThruTollGate(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    // Check if already in Al-Kharid
    const pos = getPlayerPos(ctx);
    if (pos && pos.x >= 3270) {
        console.log('Already in Al-Kharid');
        return true;
    }

    console.log('Walking to toll gate...');
    if (!await walkToPosition(ctx, stats, LOCATIONS.TOLL_GATE, 'toll gate')) {
        console.warn('Could not reach toll gate');
        return false;
    }

    // Find and interact with gate
    const gate = ctx.sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name));
    if (!gate) {
        console.warn('Gate not found');
        return false;
    }

    const openOpt = gate.optionsWithIndex.find(o => /open|pay/i.test(o.text));
    if (!openOpt) {
        console.warn('No open option on gate');
        return false;
    }

    console.log('Opening toll gate...');
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
    await new Promise(r => setTimeout(r, 1000));

    // Handle dialog - click through until "Yes" option appears
    for (let i = 0; i < 20; i++) {
        const state = ctx.sdk.getState();
        if (!state?.dialog.isOpen) {
            // Check if we're already through
            const pos = getPlayerPos(ctx);
            if (pos && pos.x >= 3270) {
                console.log('Passed through toll gate!');
                return true;
            }
            await new Promise(r => setTimeout(r, 200));
            continue;
        }

        const yesOpt = state.dialog.options.find(o => /yes/i.test(o.text));
        if (yesOpt) {
            console.log('Paying toll...');
            await ctx.sdk.sendClickDialog(yesOpt.index);
            await new Promise(r => setTimeout(r, 500));
            continue;  // Keep checking dialog/position
        }
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
    }

    // Wait and walk through repeatedly
    await new Promise(r => setTimeout(r, 500));
    for (let i = 0; i < 10; i++) {
        // Check if already through
        const pos = getPlayerPos(ctx);
        if (pos && pos.x >= 3270) {
            console.log('Passed through toll gate!');
            return true;
        }

        // Dismiss any remaining dialogs
        if (ctx.sdk.getState()?.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
        }

        // Try to walk through
        await ctx.sdk.sendWalk(3277, 3227, true);  // Inside Al-Kharid
        await new Promise(r => setTimeout(r, 1500));
    }

    console.warn('Failed to pass through toll gate');
    return false;
}

/**
 * Phase 0c: Drop non-essential items to make room for fish
 */
async function dropNonEssentials(ctx: ScriptContext, stats: Stats): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) return;

    // Keep: fishing net, coins (for kebabs if needed)
    // Keep: net, coins, food items (for emergency healing)
    // Note: only keep NON-raw shrimps (the cooked one in starting inventory)
    const essentialPatterns = [/fishing\s*net/i, /coins/i, /bread/i, /^shrimps$/i];

    const itemsToDrop = state.inventory.filter(item =>
        !essentialPatterns.some(p => p.test(item.name))
    );

    if (itemsToDrop.length === 0) {
        console.log('No non-essential items to drop');
        return;
    }

    console.log(`Dropping ${itemsToDrop.length} non-essential items...`);
    for (const item of itemsToDrop) {
        await ctx.sdk.sendDropItem(item.slot);
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`Inventory now has ${ctx.sdk.getState()?.inventory.length ?? 0} items, ${getAvailableSlots(ctx)} slots free`);
}

/**
 * Phase 1: Fish until inventory full at Al-Kharid
 */
async function fishUntilFull(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log(`Phase 1: Fishing at Al-Kharid until inventory full...`);
    let lastFishCount = countRawFish(ctx);
    let noSpotCount = 0;

    // Fish until inventory full
    while (getAvailableSlots(ctx) > 0) {
        // Check HP and eat if needed
        await eatIfLowHp(ctx, stats);

        // Dismiss dialogs first
        if (await dismissDialogs(ctx, stats) > 0) continue;

        // Check for new fish
        const currentFish = countRawFish(ctx);
        if (currentFish > lastFishCount) {
            stats.fishCaught += currentFish - lastFishCount;
            if (currentFish % 5 === 0) {
                console.log(`Fish caught: ${stats.fishCaught} (${getAvailableSlots(ctx)} slots free)`);
            }
            noSpotCount = 0;
        }
        lastFishCount = currentFish;

        // Find and use fishing spot
        const spot = findFishingSpot(ctx);
        if (!spot) {
            noSpotCount++;
            if (noSpotCount % 50 === 0) console.log('Waiting for fishing spot...');

            // Check if we drifted too far (e.g., respawned in Lumbridge)
            if (noSpotCount > 50) {
                const dist = distanceTo(ctx, LOCATIONS.ALKHARID_FISHING);
                const pos = getPlayerPos(ctx);
                if (dist > 30) {
                    console.log(`Drifted too far (${dist} tiles at ${pos?.x},${pos?.z}), walking back...`);

                    // Check if we're in Lumbridge (x < 3260) and need to pass toll gate
                    if (pos && pos.x < 3260) {
                        console.log('Respawned in Lumbridge, need to handle re-entry');
                        // If we still have fish, we already made progress - just go to cooking
                        if (countRawFish(ctx) > 5) {
                            console.log('Have fish to cook, skipping re-entry to Al-Kharid');
                            return;  // Exit fishing phase, will proceed to cooking
                        }
                        // Check if we have coins for toll
                        const coins = ctx.sdk.getState()?.inventory.find(i => /coins/i.test(i.name));
                        if (!coins || coins.count < 10) {
                            console.log('No coins for toll, cannot re-enter Al-Kharid');
                            throw new Error('Respawned without coins, cannot continue');
                        }
                        // Pass through toll gate
                        const passedToll = await passThruTollGate(ctx, stats);
                        if (!passedToll) {
                            throw new Error('Could not re-enter Al-Kharid after respawn');
                        }
                    }

                    await walkToPosition(ctx, stats, LOCATIONS.ALKHARID_FISHING, 'Al-Kharid fishing');
                    noSpotCount = 0;
                    continue;
                }
            }

            // Walk around if no spot for too long
            if (noSpotCount > 100) {
                console.log('No spot visible, walking around...');
                await ctx.sdk.sendWalk(
                    LOCATIONS.ALKHARID_FISHING.x + (Math.random() > 0.5 ? 3 : -3),
                    LOCATIONS.ALKHARID_FISHING.z,
                    true
                );
                await new Promise(r => setTimeout(r, 1500));
                noSpotCount = 0;
            }

            await new Promise(r => setTimeout(r, 100));
            continue;
        }

        noSpotCount = 0;
        const netOpt = spot.optionsWithIndex.find(o => /^net$/i.test(o.text));
        if (!netOpt) {
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        await ctx.sdk.sendInteractNpc(spot.index, netOpt.opIndex);
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Inventory full: ${countRawFish(ctx)} raw fish`);
}

/**
 * Phase 2: Cook all fish at Al-Kharid range
 */
async function cookAllFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log('Phase 2: Walking to Al-Kharid range...');

    if (!await walkToPosition(ctx, stats, LOCATIONS.ALKHARID_RANGE, 'Al-Kharid range')) {
        console.warn('Could not reach range');
        return;
    }

    console.log('Cooking fish at range...');

    // Find the range
    const range = ctx.sdk.getState()?.nearbyLocs.find(loc => /range|stove/i.test(loc.name));
    if (!range) {
        console.warn('No range found nearby');
        const locs = ctx.sdk.getState()?.nearbyLocs.slice(0, 10) ?? [];
        console.log(`Nearby locs: ${locs.map(l => l.name).join(', ')}`);
        return;
    }

    console.log(`Found: ${range.name} at (${range.x}, ${range.z})`);

    const cookingXpBefore = getCookingXp(ctx);
    const rawFishBefore = countRawFish(ctx);

    // Cook each raw fish
    while (countRawFish(ctx) > 0) {
        await dismissDialogs(ctx, stats, 1);

        const rawFish = getRawFishItems(ctx)[0];
        if (!rawFish) break;

        // Use fish on range
        await ctx.sdk.sendUseItemOnLoc(rawFish.slot, range.x, range.z, range.id);

        // Wait for cooking interface or direct cooking
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 300));

            const state = ctx.sdk.getState();

            // Handle cooking interface if it appears
            const firstInterfaceOpt = state?.interface?.options[0];
            if (state?.interface?.isOpen && firstInterfaceOpt) {
                console.log('Clicking cook option...');
                await ctx.sdk.sendClickInterfaceOption(0);
                // Wait for batch cooking to complete
                let noChange = 0;
                while (noChange < 15 && countRawFish(ctx) > 0) {
                    await new Promise(r => setTimeout(r, 400));
                    await dismissDialogs(ctx, stats, 1);
                    const prev = countRawFish(ctx);
                    await new Promise(r => setTimeout(r, 200));
                    if (countRawFish(ctx) === prev) noChange++;
                    else noChange = 0;
                }
                break;
            }

            // Handle dialog
            if (state?.dialog?.isOpen) {
                await ctx.sdk.sendClickDialog(0);
            }

            // Check if this fish was cooked
            const currentRaw = countRawFish(ctx);
            if (currentRaw < rawFishBefore) {
                break;
            }
        }
    }

    // Calculate results
    const xpGained = getCookingXp(ctx) - cookingXpBefore;
    const fishCooked = rawFishBefore - countRawFish(ctx);
    stats.fishCooked += fishCooked;

    console.log(`Cooked ${fishCooked} fish (XP: +${xpGained})`);
}

/**
 * Phase 3: Drop all cooked and burnt fish
 */
async function dropAllFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) return;

    // Drop everything except fishing net
    const itemsToDrop = state.inventory.filter(item =>
        /shrimp|anchov/i.test(item.name) ||
        /^burnt\s/i.test(item.name)
    );

    if (itemsToDrop.length === 0) {
        console.log('Nothing to drop');
        return;
    }

    console.log(`Dropping ${itemsToDrop.length} items...`);
    for (const item of itemsToDrop) {
        await ctx.sdk.sendDropItem(item.slot);
        await new Promise(r => setTimeout(r, 100));
    }
}

/**
 * Log final statistics
 */
function logFinalStats(ctx: ScriptContext, stats: Stats) {
    const state = ctx.sdk.getState();
    const cooking = state?.skills.find(s => s.name === 'Cooking');

    const cookingXpGained = (cooking?.experience ?? 0) - stats.startCookingXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    console.log('');
    console.log('=== Final Results ===');
    console.log(`Duration: ${Math.round(duration)}s`);
    console.log(`Cycles: ${stats.cycles}`);
    console.log(`--- Cooking ---`);
    console.log(`  Level: ${cooking?.baseLevel ?? '?'}`);
    console.log(`  XP Gained: ${cookingXpGained}`);
    console.log(`  Fish Caught: ${stats.fishCaught}`);
    console.log(`  Fish Cooked: ${stats.fishCooked}`);
}

/**
 * Main loop
 */
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    const GOAL_LEVEL = 10;

    console.log('=== Cooking Trainer (v3 - Al-Kharid) ===');
    console.log(`Goal: Reach Cooking level ${GOAL_LEVEL}`);
    console.log(`Starting level: ${getCookingLevel(ctx)}`);
    console.log(`Position: (${ctx.sdk.getState()?.player?.worldX}, ${ctx.sdk.getState()?.player?.worldZ})`);
    console.log(`Inventory: ${ctx.sdk.getState()?.inventory.length ?? 0} items`);

    await ctx.bot.dismissBlockingUI();

    // Phase 0a: Sell shortbow for coins
    const gotCoins = await sellShortbowForCoins(ctx, stats);
    if (!gotCoins) {
        throw new Error('Could not get coins for toll');
    }

    // Phase 0b: Pass through toll gate to Al-Kharid
    const enteredAlKharid = await passThruTollGate(ctx, stats);
    if (!enteredAlKharid) {
        throw new Error('Could not enter Al-Kharid');
    }

    // Phase 0c: Drop non-essential items
    await dropNonEssentials(ctx, stats);

    // Walk to Al-Kharid fishing spot
    console.log('Walking to Al-Kharid fishing spot...');
    if (!await walkToPosition(ctx, stats, LOCATIONS.ALKHARID_FISHING, 'Al-Kharid fishing')) {
        throw new Error('Could not reach Al-Kharid fishing spot');
    }

    while (getCookingLevel(ctx) < GOAL_LEVEL) {
        stats.cycles++;
        console.log(`\n--- Cycle ${stats.cycles} (Cooking level ${getCookingLevel(ctx)}) ---`);

        // Phase 1: Fish until inventory full
        await fishUntilFull(ctx, stats);

        // Phase 2: Cook at range
        await cookAllFish(ctx, stats);

        // Phase 3: Drop cooked fish
        await dropAllFish(ctx, stats);

        // Walk back to fishing spot
        console.log('Returning to fishing spot...');
        await walkToPosition(ctx, stats, LOCATIONS.ALKHARID_FISHING, 'Al-Kharid fishing');
    }

    console.log(`\nGoal achieved! Cooking level ${getCookingLevel(ctx)}`);
}

async function main() {
    // Create fresh account
    const username = `CK${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            const stats: Stats = {
                fishCaught: 0,
                fishCooked: 0,
                fishBurnt: 0,
                cycles: 0,
                startCookingXp: getCookingXp(ctx),
                startTime: Date.now(),
                lastProgressTime: Date.now(),
            };

            try {
                await mainLoop(ctx, stats);
            } catch (e) {
                console.error(`Script aborted: ${e}`);
                throw e;
            } finally {
                logFinalStats(ctx, stats);
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 15 * 60 * 1000,
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
