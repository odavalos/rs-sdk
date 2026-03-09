/**
 * Fishing + Cooking Speedrun Script (v4 - Range & Bank)
 *
 * Goal: Maximize combined Fishing+Cooking level in 10 minutes at Al-Kharid.
 *
 * Strategy:
 * - Fish at Al-Kharid fishing spots until inventory full
 * - Walk to Al-Kharid range and cook all fish
 * - Walk to Al-Kharid bank and deposit cooked fish
 * - Return to fishing spot and repeat
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc, NearbyLoc, InventoryItem } from '../../sdk/types';

// Al-Kharid locations
const LOCATIONS = {
    FISHING_SPOT: { x: 3267, z: 3148 },   // Safe shrimp fishing
    RANGE: { x: 3273, z: 3180 },          // Al-Kharid range
    BANK: { x: 3269, z: 3167 },           // Al-Kharid bank
};

interface Stats {
    fishCaught: number;
    fishCooked: number;
    fishBanked: number;
    cycles: number;
    startFishingXp: number;
    startCookingXp: number;
    startTime: number;
    lastProgressTime: number;
}

// ============ Helper Functions ============

function getFishingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Fishing')?.experience ?? 0;
}

function getFishingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Fishing')?.baseLevel ?? 1;
}

function getCookingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Cooking')?.experience ?? 0;
}

function getCookingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Cooking')?.baseLevel ?? 1;
}

function getCombinedLevel(ctx: ScriptContext): number {
    return getFishingLevel(ctx) + getCookingLevel(ctx);
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
 * Find the nearest fishing spot (Net option)
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
 * Find any fishing spot nearby (for debugging)
 */
function findAnyFishingSpot(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    return state.nearbyNpcs
        .filter(npc => /fishing\s*spot/i.test(npc.name))
        .sort((a, b) => a.distance - b.distance)[0] ?? null;
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
 * Count cooked fish in inventory (shrimp/anchovies without "raw" prefix)
 */
function countCookedFish(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;

    return state.inventory
        .filter(item =>
            /shrimp|anchov/i.test(item.name) &&
            !/^raw\s/i.test(item.name) &&
            !/^burnt\s/i.test(item.name))
        .reduce((sum, item) => sum + item.count, 0);
}

/**
 * Get cooked fish items in inventory
 */
function getCookedFishItems(ctx: ScriptContext): InventoryItem[] {
    const state = ctx.sdk.getState();
    if (!state) return [];

    return state.inventory.filter(item =>
        /shrimp|anchov/i.test(item.name) &&
        !/^raw\s/i.test(item.name) &&
        !/^burnt\s/i.test(item.name));
}

/**
 * Get inventory count (used slots)
 */
function getInventoryCount(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.inventory.length ?? 0;
}

/**
 * Get count of non-fishing-net items (to check for fish capacity)
 */
function getAvailableFishSlots(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;
    // Count items that aren't fishing net
    const nonNetItems = state.inventory.filter(i => !/fishing\s*net/i.test(i.name)).length;
    return 27 - nonNetItems;  // 27 fish slots (28 total - 1 net)
}

/**
 * Dismiss dialogs (max count to avoid loops)
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
 * Walk to a position and wait to arrive (handles long distances)
 */
async function walkToPosition(ctx: ScriptContext, stats: Stats, target: { x: number; z: number }, name: string): Promise<boolean> {
    const startDist = distanceTo(ctx, target);
    console.log(`Walking to ${name} (${target.x}, ${target.z}), dist: ${startDist}...`);

    // For long distances, use bot.walkTo which handles pathfinding
    if (startDist > 30) {
        console.log('Long distance walk, using pathfinding...');
        const posBefore = getPlayerPos(ctx);
        try {
            await ctx.bot.walkTo(target.x, target.z);
        } catch (e) {
            console.warn(`Pathfinding error: ${e}`);
        }
        const posAfter = getPlayerPos(ctx);
        const finalDist = distanceTo(ctx, target);
        console.log(`Moved from (${posBefore?.x},${posBefore?.z}) to (${posAfter?.x},${posAfter?.z}), dist: ${finalDist}`);

        if (finalDist <= 10) {
            console.log(`Arrived at ${name}`);
            return true;
        }

        // If we didn't move at all, try dismissing dialogs and waiting
        if (posBefore?.x === posAfter?.x && posBefore?.z === posAfter?.z) {
            console.log('Position unchanged - checking for blocking UI...');
            await ctx.bot.dismissBlockingUI();
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    // Direct walking for short distances
    await ctx.sdk.sendWalk(target.x, target.z, true);

    // Wait to arrive (within 5 tiles)
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 400));

        // Dismiss any dialogs
        await dismissDialogs(ctx, stats, 1);

        const dist = distanceTo(ctx, target);
        if (dist <= 5) {
            console.log(`Arrived at ${name}`);
            return true;
        }

        // Re-send walk periodically
        if (i > 0 && i % 5 === 0) {
            await ctx.sdk.sendWalk(target.x, target.z, true);
        }
    }

    console.warn(`Failed to reach ${name} (dist: ${distanceTo(ctx, target)})`);
    return false;
}

// ============ Main Phases ============

/**
 * Phase 1: Fish until inventory is full
 */
async function fishUntilFull(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log('Phase 1: Fishing until inventory full...');
    let lastFishCount = countRawFish(ctx);
    let attempts = 0;
    let noSpotCount = 0;

    // Fish until no available slots for raw fish
    while (getAvailableFishSlots(ctx) > 0) {
        attempts++;

        // Dismiss dialogs
        if (await dismissDialogs(ctx, stats) > 0) continue;

        // Check for new fish
        const currentFish = countRawFish(ctx);
        if (currentFish > lastFishCount) {
            stats.fishCaught += currentFish - lastFishCount;
            if (currentFish % 5 === 0 || currentFish - lastFishCount > 1) {
                console.log(`Fish caught: ${stats.fishCaught} (slots: ${getAvailableFishSlots(ctx)} free)`);
            }
            noSpotCount = 0;  // Reset counter when we catch fish
        }
        lastFishCount = currentFish;

        // Find and use fishing spot
        const spot = findFishingSpot(ctx);
        if (!spot) {
            noSpotCount++;
            if (noSpotCount % 50 === 0) console.log('Waiting for fishing spot...');

            // If no spot found for too long, try to find any spot and walk to it
            if (noSpotCount > 100) {  // ~10 seconds
                const playerPos = getPlayerPos(ctx);
                const distToSpot = distanceTo(ctx, LOCATIONS.FISHING_SPOT);
                console.log(`Position: (${playerPos?.x}, ${playerPos?.z}), dist to fishing: ${distToSpot}`);

                // If we're far from the fishing area (e.g. teleported to Lumbridge), walk back
                if (distToSpot > 20) {
                    console.log(`Too far from fishing spot, walking back...`);
                    await walkToPosition(ctx, stats, LOCATIONS.FISHING_SPOT, 'fishing spot');
                } else {
                    // We're close but no spot - check if there's any fishing spot
                    const anySpot = findAnyFishingSpot(ctx);
                    if (anySpot) {
                        console.log(`Found fishing spot at (${anySpot.x}, ${anySpot.z}), options: ${anySpot.options.join(', ')}`);
                        await ctx.sdk.sendWalk(anySpot.x, anySpot.z, true);
                        await new Promise(r => setTimeout(r, 2000));
                    } else {
                        const nearbyNpcs = ctx.sdk.getState()?.nearbyNpcs.slice(0, 5) ?? [];
                        console.log(`No spot visible. NPCs: ${nearbyNpcs.map(n => n.name).join(', ') || 'none'}`);
                        // Walk around a bit to find the spot
                        await ctx.sdk.sendWalk(LOCATIONS.FISHING_SPOT.x + (Math.random() > 0.5 ? 3 : -3), LOCATIONS.FISHING_SPOT.z, true);
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
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
 * Phase 2: Cook all fish at the range
 */
async function cookAllFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    // Walk to range
    if (!await walkToPosition(ctx, stats, LOCATIONS.RANGE, 'range')) {
        console.warn('Could not reach range');
        return;
    }

    console.log('Phase 2: Cooking fish at range...');

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

    // Cook each raw fish one at a time (game may not have batch cooking interface)
    while (countRawFish(ctx) > 0) {
        const rawFish = getRawFishItems(ctx)[0];
        if (!rawFish) break;

        // Use fish on range
        await ctx.sdk.sendUseItemOnLoc(rawFish.slot, range.x, range.z, range.id);

        // Wait for cooking to happen (XP gain or raw fish count decrease)
        // Also handle any interface/dialog that appears
        for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 300));

            const state = ctx.sdk.getState();

            // Handle cooking interface if it appears
            const firstInterfaceOpt = state?.interface?.options[0];
            if (state?.interface?.isOpen && firstInterfaceOpt) {
                console.log('Clicking cook option...');
                await ctx.sdk.sendClickInterfaceOption(0);
                // After clicking, wait for batch cooking to complete
                let noChange = 0;
                while (noChange < 10 && countRawFish(ctx) > 0) {
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

            // Check if this fish was cooked (raw count decreased)
            if (countRawFish(ctx) < rawFishBefore - stats.fishCooked) {
                break;
            }
        }
    }

    // Calculate results
    const xpGained = getCookingXp(ctx) - cookingXpBefore;
    const fishCooked = rawFishBefore - countRawFish(ctx);
    stats.fishCooked += Math.max(0, fishCooked);

    console.log(`Cooked ${fishCooked} fish (XP: +${xpGained})`);
    console.log(`Done cooking. Cooked fish in inventory: ${countCookedFish(ctx)}`);
}

/**
 * Phase 3: Clear cooked fish (bank or drop)
 */
async function clearCookedFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    const cookedBefore = countCookedFish(ctx);
    if (cookedBefore === 0) {
        console.log('No cooked fish to clear');
        return;
    }

    console.log(`Phase 3: Clearing ${cookedBefore} cooked fish...`);

    // Try banking first
    const bankSuccess = await tryBanking(ctx, stats, cookedBefore);

    if (!bankSuccess) {
        // Banking failed - drop cooked fish instead
        console.log('Banking failed, dropping cooked fish...');
        await dropCookedFish(ctx, stats);
    }
}

/**
 * Try to bank cooked fish
 */
async function tryBanking(ctx: ScriptContext, stats: Stats, cookedBefore: number): Promise<boolean> {
    // Walk to bank
    if (!await walkToPosition(ctx, stats, LOCATIONS.BANK, 'bank')) {
        return false;
    }

    // Debug: log what we see at the bank
    const state = ctx.sdk.getState();
    const bankBooths = state?.nearbyLocs.filter(l => /bank/i.test(l.name)) ?? [];
    const bankers = state?.nearbyNpcs.filter(n => /banker/i.test(n.name)) ?? [];
    console.log(`At bank: ${bankBooths.length} booths, ${bankers.length} bankers`);

    // Try banker NPC first (more reliable)
    const banker = bankers.find(n => n.optionsWithIndex.some(o => /bank/i.test(o.text)));
    if (banker) {
        const bankOpt = banker.optionsWithIndex.find(o => /^bank$/i.test(o.text));
        if (bankOpt) {
            console.log(`Using banker: ${banker.name}, option ${bankOpt.opIndex}: ${bankOpt.text}`);
            await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);

            // Wait for interface or dialog
            const opened = await waitForBankInterface(ctx, stats);
            if (opened) {
                return await depositCookedFish(ctx, stats, cookedBefore);
            }
        }
    }

    // Try bank booth with different options
    const bankBooth = bankBooths[0];
    if (bankBooth) {
        console.log(`  Booth: ${bankBooth.name} at (${bankBooth.x}, ${bankBooth.z}), options: ${bankBooth.optionsWithIndex.map(o => `${o.opIndex}:${o.text}`).join(', ')}`);

        // Try "Bank" option first, then "Use-quickly", then "Use"
        const options = [
            bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)),
            bankBooth.optionsWithIndex.find(o => /use-quickly/i.test(o.text)),
            bankBooth.optionsWithIndex.find(o => /^use$/i.test(o.text)),
        ].filter(Boolean);

        for (const opt of options) {
            if (!opt) continue;
            console.log(`Trying bank booth option ${opt.opIndex}: ${opt.text}`);
            await ctx.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, opt.opIndex);

            const opened = await waitForBankInterface(ctx, stats);
            if (opened) {
                return await depositCookedFish(ctx, stats, cookedBefore);
            }
        }
    }

    console.warn('Bank interface did not open');
    return false;
}

/**
 * Wait for bank interface to open (handling dialogs)
 */
async function waitForBankInterface(ctx: ScriptContext, stats: Stats): Promise<boolean> {
    // Wait for interface OR dialog to appear
    for (let i = 0; i < 40; i++) {  // 8 seconds total
        await new Promise(r => setTimeout(r, 200));

        const currentState = ctx.sdk.getState();

        // Bank interface opened!
        if (currentState?.interface?.isOpen) {
            console.log(`Bank interface opened! (id: ${currentState.interface.interfaceId})`);
            return true;
        }

        // Click through dialogs
        if (currentState?.dialog?.isOpen) {
            const text = currentState.dialog.text || '';
            const options = currentState.dialog.options;
            console.log(`Dialog: "${text.substring(0, 50)}..." options: ${options.map(o => o.text).join(', ')}`);

            // Look for bank-related option or just click first option
            const bankOption = options.find(o => /bank/i.test(o.text));
            const firstOption = options[0];
            if (bankOption) {
                await ctx.sdk.sendClickDialog(bankOption.index);
            } else if (firstOption) {
                await ctx.sdk.sendClickDialog(firstOption.index);
            } else {
                await ctx.sdk.sendClickDialog(0);
            }
            await new Promise(r => setTimeout(r, 300));
        }
    }
    return false;
}

/**
 * Deposit cooked fish when bank interface is open
 */
async function depositCookedFish(ctx: ScriptContext, stats: Stats, cookedBefore: number): Promise<boolean> {
    const currentState = ctx.sdk.getState();
    if (!currentState?.interface?.isOpen) {
        console.warn('Bank interface not open');
        return false;
    }

    // Deposit all cooked and burnt fish
    const itemsToDeposit = currentState.inventory.filter(item =>
        (/shrimp|anchov/i.test(item.name) && !/^raw\s/i.test(item.name)) ||
        /^burnt\s/i.test(item.name));

    console.log(`Depositing ${itemsToDeposit.length} items...`);
    for (const item of itemsToDeposit) {
        console.log(`  ${item.name} x${item.count} from slot ${item.slot}`);
        await ctx.sdk.sendBankDeposit(item.slot, item.count);
        await new Promise(r => setTimeout(r, 150));
    }

    await new Promise(r => setTimeout(r, 300));
    const cookedAfter = countCookedFish(ctx);
    const deposited = cookedBefore - cookedAfter;
    stats.fishBanked += Math.max(0, deposited);

    // Bank interface closes automatically when we walk away
    console.log(`Banked ${deposited} fish (total: ${stats.fishBanked})`);
    return deposited > 0;
}

/**
 * Drop all cooked and burnt fish
 */
async function dropCookedFish(ctx: ScriptContext, stats: Stats): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) return;

    const itemsToDrop = state.inventory.filter(item =>
        (/shrimp|anchov/i.test(item.name) && !/^raw\s/i.test(item.name)) ||
        /^burnt\s/i.test(item.name));

    let dropped = 0;
    for (const item of itemsToDrop) {
        await ctx.sdk.sendDropItem(item.slot);
        dropped += item.count;
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`Dropped ${dropped} cooked/burnt fish`);
}

/**
 * Log final statistics
 */
function logFinalStats(ctx: ScriptContext, stats: Stats) {
    const state = ctx.sdk.getState();
    const fishing = state?.skills.find(s => s.name === 'Fishing');
    const cooking = state?.skills.find(s => s.name === 'Cooking');

    const fishingXpGained = (fishing?.experience ?? 0) - stats.startFishingXp;
    const cookingXpGained = (cooking?.experience ?? 0) - stats.startCookingXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    console.log('');
    console.log('=== Final Results ===');
    console.log(`Duration: ${Math.round(duration)}s`);
    console.log(`Cycles: ${stats.cycles}`);
    console.log(`--- Fishing ---`);
    console.log(`  Level: ${fishing?.baseLevel ?? '?'}`);
    console.log(`  XP Gained: ${fishingXpGained}`);
    console.log(`  Fish Caught: ${stats.fishCaught}`);
    console.log(`--- Cooking ---`);
    console.log(`  Level: ${cooking?.baseLevel ?? '?'}`);
    console.log(`  XP Gained: ${cookingXpGained}`);
    console.log(`  Fish Cooked: ${stats.fishCooked}`);
    console.log(`  Fish Banked: ${stats.fishBanked}`);
    console.log(`--- Combined ---`);
    console.log(`  COMBINED LEVEL: ${(fishing?.baseLevel ?? 1) + (cooking?.baseLevel ?? 1)}`);
}

/**
 * Ensure we're at the fishing spot
 */
async function ensureAtFishingSpot(ctx: ScriptContext, stats: Stats): Promise<void> {
    const pos = getPlayerPos(ctx);
    const dist = distanceTo(ctx, LOCATIONS.FISHING_SPOT);
    console.log(`Current position: (${pos?.x}, ${pos?.z}), distance to fishing spot: ${dist}`);

    if (dist > 10) {
        console.log('Not at fishing spot, walking there...');
        await walkToPosition(ctx, stats, LOCATIONS.FISHING_SPOT, 'fishing spot');
    }
}

/**
 * Main loop: fish → cook at range → bank → repeat
 */
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log('=== Fishing + Cooking Speedrun (v4 - Range & Bank) ===');
    console.log(`Starting levels: Fishing ${getFishingLevel(ctx)}, Cooking ${getCookingLevel(ctx)}`);
    console.log(`Combined: ${getCombinedLevel(ctx)}`);
    console.log(`Position: (${ctx.sdk.getState()?.player?.worldX}, ${ctx.sdk.getState()?.player?.worldZ})`);

    await ctx.bot.dismissBlockingUI();

    // Ensure we start at the fishing spot
    await ensureAtFishingSpot(ctx, stats);

    while (true) {
        stats.cycles++;
        console.log(`\n--- Cycle ${stats.cycles} ---`);
        console.log(`Current levels: Fishing ${getFishingLevel(ctx)}, Cooking ${getCookingLevel(ctx)} = ${getCombinedLevel(ctx)}`);

        // Phase 1: Fish until inventory full
        await fishUntilFull(ctx, stats);

        // Phase 2: Walk to range and cook
        await cookAllFish(ctx, stats);

        // Phase 3: Bank or drop cooked fish
        await clearCookedFish(ctx, stats);

        // Phase 4: Walk back to fishing spot
        console.log('Phase 4: Returning to fishing spot...');
        await walkToPosition(ctx, stats, LOCATIONS.FISHING_SPOT, 'fishing spot');
    }
}

async function main() {
    // Create fresh account
    const username = `FS${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.FISHER_COOK_AT_DRAYNOR);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            const stats: Stats = {
                fishCaught: 0,
                fishCooked: 0,
                fishBanked: 0,
                cycles: 0,
                startFishingXp: getFishingXp(ctx),
                startCookingXp: getCookingXp(ctx),
                startTime: Date.now(),
                lastProgressTime: Date.now(),
            };

            try {
                await mainLoop(ctx, stats);
            } catch (e) {
                if (e instanceof Error) {
                    console.error(`Script aborted: ${e.message}`);
                } else {
                    throw e;
                }
            } finally {
                logFinalStats(ctx, stats);
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 10 * 60 * 1000,
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
