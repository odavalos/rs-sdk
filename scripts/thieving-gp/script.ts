/**
 * Thieving GP Maximizer Script
 *
 * Goal: Maximize coins earned through thieving in 5 minutes.
 *
 * Strategy v11:
 * - Level 1-9: Pickpocket Men at Lumbridge (3 GP each)
 * - Level 10+: Walk to Farmers (9 GP each) - proven strategy from v7
 * - Larger zone radius (40 tiles) to avoid constant zone re-entry
 * - Walk TO Farmer spawn when no target found (not random)
 *
 * v7: 339 GP (Farmers with door handling) - BASELINE
 * v8: 206 GP (REGRESSION - Men in Al-Kharid)
 * v9: 36 GP (FAILURE - Warriors not found)
 * v10: 195 GP (REGRESSION - constant zone re-walking)
 * v11 Target: 350+ GP with Farmers only, optimized zone handling
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc } from '../../sdk/types';

// Thieving stats tracking
interface ThievingStats {
    pickpocketAttempts: number;
    successfulPickpockets: number;
    failedPickpockets: number;
    coinsEarned: number;
    startCoins: number;
    startThievingXp: number;
    foodEaten: number;
    stunTimeMs: number;
}

// Stun duration in ticks (~4.5 seconds = 7-8 game ticks)
const STUN_TICKS = 8;
const STUN_MS = 4800;

// v10: Simple zone switching - Men then Farmers (proven reliable)
const ZONES = {
    lumbridge: { x: 3222, z: 3218, targetPattern: /^(man|woman)$/i, levelReq: 1, coins: 3 },
    // Farmer area near crop patches (proven in v7: 339 GP)
    farmers: { x: 3167, z: 3283, targetPattern: /^farmer$/i, levelReq: 10, coins: 9 },
};

// Key locations
const LOCATIONS = {
    lumbridgeGeneralStore: { x: 3211, z: 3247 },
    alKharidTollGate: { x: 3268, z: 3228 },
    alKharidInside: { x: 3277, z: 3227 },
    kebabSeller: { x: 3273, z: 3180 },  // Karim the kebab seller (dialog, not shop)
};

// State tracking for one-time setup
interface SetupState {
    soldShortbow: boolean;
    paidToll: boolean;
    boughtKebabs: boolean;
    tollAttempted: boolean;  // Track if we've tried to enter Al-Kharid
}

/**
 * Walk to destination, opening any doors/gates encountered along the way
 */
async function walkToWithDoors(ctx: ScriptContext, destX: number, destZ: number, maxAttempts: number = 5): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const state = ctx.sdk.getState();
        if (!state?.player) return false;

        // Check if we're close enough
        const dx = Math.abs(state.player.worldX - destX);
        const dz = Math.abs(state.player.worldZ - destZ);
        if (dx <= 5 && dz <= 5) {
            return true; // Arrived!
        }

        // Try walking
        const walkResult = await ctx.bot.walkTo(destX, destZ);

        // Check if we made progress
        const stateAfter = ctx.sdk.getState();
        if (stateAfter?.player) {
            const dxAfter = Math.abs(stateAfter.player.worldX - destX);
            const dzAfter = Math.abs(stateAfter.player.worldZ - destZ);
            if (dxAfter <= 5 && dzAfter <= 5) {
                return true; // Arrived!
            }
        }

        // If walk failed or we're stuck, look for a door/gate to open
        const doors = ctx.sdk.getNearbyLocs()
            .filter(loc => /door|gate/i.test(loc.name))
            .filter(loc => loc.options.some(o => /^open$/i.test(o)))
            .sort((a, b) => a.distance - b.distance);

        if (doors.length > 0) {
            const door = doors[0]!;
            console.log(`Opening ${door.name} at (${door.x}, ${door.z})...`);
            const openResult = await ctx.bot.openDoor(door);
            if (openResult.success) {
                console.log(`Opened ${door.name}`);
                continue; // Try walking again
            } else {
                console.warn(`Failed to open ${door.name}: ${openResult.message}`);
            }
        }

        // If no doors found and walk failed, we might be stuck
        if (!walkResult.success) {
            console.warn(`Walk failed: ${walkResult.message}`);
            return false;
        }
    }
    return false;
}

/**
 * Check if we're in Al-Kharid (x >= 3270)
 */
function isInAlKharid(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    return (state?.player?.worldX ?? 0) >= 3270;
}

/**
 * Sell shortbow at Lumbridge general store for 20gp (for toll + extra)
 * From script_best_practices.md: shortbow sells for 20gp, better than bronze sword (10gp)
 */
async function sellShortbow(ctx: ScriptContext): Promise<boolean> {
    const shortbow = ctx.sdk.findInventoryItem(/^shortbow$/i);
    if (!shortbow) {
        console.log('No shortbow to sell');
        return false;
    }

    console.log('Selling shortbow for toll money (20gp)...');

    // Walk to general store
    await walkToWithDoors(ctx, LOCATIONS.lumbridgeGeneralStore.x, LOCATIONS.lumbridgeGeneralStore.z);

    // Open shop
    const shopResult = await ctx.bot.openShop(/shop keeper|shop assistant/i);
    if (!shopResult.success) {
        console.warn(`Failed to open shop: ${shopResult.message}`);
        return false;
    }

    // Sell the shortbow
    const sellResult = await ctx.bot.sellToShop(/shortbow/i);
    if (!sellResult.success) {
        console.warn(`Failed to sell shortbow: ${sellResult.message}`);
    }

    // Close shop
    await ctx.bot.closeShop();

    console.log('Sold shortbow for 20gp');
    return true;
}

/**
 * Pay toll and enter Al-Kharid (from script_best_practices.md)
 */
async function payTollAndEnterAlKharid(ctx: ScriptContext): Promise<boolean> {
    const coins = countCoins(ctx);
    if (coins < 10) {
        console.warn(`Not enough coins for toll (have ${coins}, need 10)`);
        return false;
    }

    console.log('Walking to Al-Kharid toll gate...');
    await walkToWithDoors(ctx, LOCATIONS.alKharidTollGate.x, LOCATIONS.alKharidTollGate.z);

    // Find and click the gate
    const state = ctx.sdk.getState();
    const gate = state?.nearbyLocs.find(l => /gate/i.test(l.name));
    if (!gate) {
        console.warn('Cannot find toll gate');
        return false;
    }

    const openOpt = gate.optionsWithIndex.find(o => /open|pay/i.test(o.text));
    if (!openOpt) {
        console.warn('Cannot find open option on gate');
        return false;
    }

    console.log('Opening toll gate...');
    await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
    await new Promise(r => setTimeout(r, 800));

    // Handle dialog - click through until "Yes" option appears
    for (let i = 0; i < 20; i++) {
        const s = ctx.sdk.getState();
        if (!s?.dialog.isOpen) {
            await new Promise(r => setTimeout(r, 150));
            continue;
        }
        const yesOpt = s.dialog.options.find(o => /yes/i.test(o.text));
        if (yesOpt) {
            console.log('Paying 10gp toll...');
            await ctx.sdk.sendClickDialog(yesOpt.index);
            break;
        }
        await ctx.sdk.sendClickDialog(0);  // Click to continue
        await new Promise(r => setTimeout(r, 200));
    }

    // Dismiss any remaining dialogs
    for (let i = 0; i < 5; i++) {
        const s = ctx.sdk.getState();
        if (!s?.dialog.isOpen) break;
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
    }

    // Wait and walk through aggressively
    await new Promise(r => setTimeout(r, 600));
    for (let i = 0; i < 5; i++) {
        // Check if already in
        if (isInAlKharid(ctx)) {
            console.log('Entered Al-Kharid!');
            return true;
        }

        console.log(`Walking through toll gate (attempt ${i + 1})...`);
        await ctx.bot.walkTo(LOCATIONS.alKharidInside.x, LOCATIONS.alKharidInside.z);
        await new Promise(r => setTimeout(r, 800));
    }

    return isInAlKharid(ctx);
}

/**
 * Buy kebabs from Al-Kharid kebab seller (uses DIALOG, not shop!)
 * From script_best_practices.md - Karim uses dialog system
 */
async function buyKebabs(ctx: ScriptContext, quantity: number = 5): Promise<boolean> {
    console.log(`Buying ${quantity} kebabs via dialog...`);

    // Walk to kebab seller (3273, 3180)
    await walkToWithDoors(ctx, 3273, 3180);

    const kebabsBefore = ctx.sdk.findInventoryItem(/^kebab$/i)?.count ?? 0;

    for (let i = 0; i < quantity; i++) {
        // Check if we have enough coins (1gp per kebab)
        const coins = countCoins(ctx);
        if (coins < 1) {
            console.warn('Not enough coins to buy kebab');
            break;
        }

        // Find kebab seller (Karim)
        const seller = ctx.sdk.findNearbyNpc(/kebab/i);
        if (!seller) {
            console.warn('Cannot find kebab seller');
            return false;
        }

        // Talk to kebab seller
        const talkOpt = seller.optionsWithIndex.find(o => /talk/i.test(o.text));
        if (!talkOpt) {
            console.warn('Cannot find talk option on kebab seller');
            return false;
        }

        await ctx.sdk.sendInteractNpc(seller.index, talkOpt.opIndex);
        await new Promise(r => setTimeout(r, 1000));

        // Handle dialog - click through and select "Yes please."
        let bought = false;
        for (let j = 0; j < 15; j++) {
            const s = ctx.sdk.getState();
            if (!s?.dialog.isOpen) {
                await new Promise(r => setTimeout(r, 200));
                continue;
            }

            const buyOpt = s.dialog.options.find(o => /yes/i.test(o.text));
            if (buyOpt) {
                await ctx.sdk.sendClickDialog(buyOpt.index);  // Buy kebab (1gp)
                bought = true;
            } else {
                await ctx.sdk.sendClickDialog(0);  // Click to continue
            }
            await new Promise(r => setTimeout(r, 300));

            // Check if dialog closed after buying
            if (bought) {
                const sAfter = ctx.sdk.getState();
                if (!sAfter?.dialog.isOpen) break;
            }
        }

        // Dismiss any remaining dialogs
        for (let j = 0; j < 3; j++) {
            const s = ctx.sdk.getState();
            if (!s?.dialog.isOpen) break;
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 200));
        }

        await new Promise(r => setTimeout(r, 200));
    }

    const kebabsAfter = ctx.sdk.findInventoryItem(/^kebab$/i)?.count ?? 0;
    const bought = kebabsAfter - kebabsBefore;
    console.log(`Bought ${bought} kebabs (now have ${kebabsAfter})`);
    return bought > 0;
}

/**
 * Get the best zone for current thieving level
 * v10: Simple - Men then Farmers (proven reliable from v7)
 */
function getBestZone(thievingLevel: number) {
    // Level 10+: Farmers (9 GP) - proven in v7 with 339 GP
    if (thievingLevel >= ZONES.farmers.levelReq) {
        return ZONES.farmers;
    }
    // Level 1-9: Lumbridge Men (3 GP)
    return ZONES.lumbridge;
}

/**
 * Check if we're in a zone
 * v11: Larger radius (40 tiles) to avoid constant zone re-entry
 */
function isInZone(ctx: ScriptContext, zone: typeof ZONES.lumbridge): boolean {
    const state = ctx.sdk.getState();
    if (!state?.player) return false;
    const dx = Math.abs(state.player.worldX - zone.x);
    const dz = Math.abs(state.player.worldZ - zone.z);
    return dx <= 40 && dz <= 40;  // Large radius - stay in zone once entered
}

/**
 * Find nearest pickpocket target matching the pattern
 */
function findPickpocketTarget(ctx: ScriptContext, pattern: RegExp): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    const targets = state.nearbyNpcs
        .filter(npc => pattern.test(npc.name))
        .filter(npc => npc.options.some(o => /pickpocket/i.test(o)))
        .sort((a, b) => a.distance - b.distance);

    return targets[0] ?? null;
}


/**
 * Check if we should eat food based on HP
 */
function shouldEat(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state) return false;

    const hp = state.skills.find(s => s.name === 'Hitpoints');
    if (!hp) return false;

    // v6: Be more conservative - only eat at HP <= 3 to preserve food
    // Success rate improves with thieving level, so later attempts are safer
    return hp.level <= 3;
}

/**
 * Check if we have food available
 */
function hasFood(ctx: ScriptContext): boolean {
    const food = ctx.sdk.findInventoryItem(/^(bread|shrimps?|cooked meat|anchovies|trout|salmon|lobster|swordfish|cake|chocolate cake|kebab)$/i);
    return food !== null;
}


/**
 * Count coins in inventory
 */
function countCoins(ctx: ScriptContext): number {
    const coins = ctx.sdk.findInventoryItem(/^coins$/i);
    return coins?.count ?? 0;
}

/**
 * Attempt to pickpocket an NPC
 * Returns result and coins gained
 */
async function attemptPickpocket(
    ctx: ScriptContext,
    target: NearbyNpc,
    stats: ThievingStats
): Promise<'success' | 'failed' | 'stunned' | 'error'> {
    const startTick = ctx.sdk.getState()?.tick ?? 0;
    const coinsBefore = countCoins(ctx);

    // Find the Pickpocket option
    const pickpocketOpt = target.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
    if (!pickpocketOpt) {
        console.warn(`No pickpocket option on ${target.name}`);
        return 'error';
    }

    // Send the pickpocket action
    const result = await ctx.sdk.sendInteractNpc(target.index, pickpocketOpt.opIndex);
    if (!result.success) {
        console.warn(`Pickpocket action failed: ${result.message}`);
        return 'error';
    }

    stats.pickpocketAttempts++;

    // Wait for result - either coins increase or we get stunned
    // Check for game messages about success/failure
    try {
        await ctx.sdk.waitForCondition(state => {
            // Check for success message or coins increasing
            for (const msg of state.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    // Success messages
                    if (text.includes('you pick') || text.includes("you steal")) {
                        return true;
                    }
                    // Failure/stun messages
                    if (text.includes("you fail") || text.includes("stunned") || text.includes("caught")) {
                        return true;
                    }
                }
            }

            // Also check if coins increased
            const currentCoins = state.inventory.find(i => /^coins$/i.test(i.name))?.count ?? 0;
            if (currentCoins > coinsBefore) {
                return true;
            }

            return false;
        }, 5000);

        // Check what happened
        const currentState = ctx.sdk.getState();
        if (!currentState) return 'error';

        const coinsAfter = countCoins(ctx);
        if (coinsAfter > coinsBefore) {
            // Success!
            const gained = coinsAfter - coinsBefore;
            stats.successfulPickpockets++;
            stats.coinsEarned += gained;
            console.log(`Pickpocketed ${target.name}! +${gained} coins (total: ${stats.coinsEarned})`);
            return 'success';
        }

        // Check for failure message
        for (const msg of currentState.gameMessages) {
            if (msg.tick > startTick) {
                const text = msg.text.toLowerCase();
                if (text.includes("you fail") || text.includes("stunned") || text.includes("caught")) {
                    stats.failedPickpockets++;
                    console.log(`Failed pickpocket - stunned for ${STUN_MS}ms`);
                    // Wait out the stun duration
                    await new Promise(r => setTimeout(r, STUN_MS));
                    stats.stunTimeMs += STUN_MS;
                    return 'stunned';
                }
            }
        }

        // Unknown result
        return 'failed';
    } catch {
        return 'error';
    }
}

/**
 * Main thieving loop
 */
async function thievingLoop(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) throw new Error('No initial state');

    // Initialize stats
    const stats: ThievingStats = {
        pickpocketAttempts: 0,
        successfulPickpockets: 0,
        failedPickpockets: 0,
        coinsEarned: 0,
        startCoins: countCoins(ctx),
        startThievingXp: state.skills.find(s => s.name === 'Thieving')?.experience ?? 0,
        foodEaten: 0,
        stunTimeMs: 0,
    };

    // v8: Setup state for Al-Kharid access
    const setup: SetupState = {
        soldShortbow: false,
        paidToll: false,
        boughtKebabs: false,
        tollAttempted: false,
    };

    console.log('=== Thieving GP Maximizer v11 Started ===');
    console.log(`Starting coins: ${stats.startCoins}`);
    console.log(`Starting thieving XP: ${stats.startThievingXp}`);

    // Main loop
    while (true) {
        const currentState = ctx.sdk.getState();
        if (!currentState) {
            console.warn('Lost game state');
            break;
        }

        // Dismiss any dialogs first
        if (currentState.dialog.isOpen) {
            console.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 600));
            continue;
        }

        // Check HP and eat if needed (conservative - only eat at HP <= 3)
        if (shouldEat(ctx)) {
            const food = ctx.sdk.findInventoryItem(/^(bread|shrimps?|cooked meat|anchovies|trout|salmon|lobster|swordfish|cake|chocolate cake|kebab)$/i);
            if (food) {
                console.log(`HP low - eating ${food.name}`);
                await ctx.bot.eatFood(food);
                stats.foodEaten++;
                continue;
            }
            // No food - if in Al-Kharid, try to buy more kebabs
            if (setup.paidToll && isInAlKharid(ctx)) {
                const coins = countCoins(ctx);
                if (coins >= 5) {
                    console.log('Out of food in Al-Kharid - buying more kebabs...');
                    await buyKebabs(ctx, 5);
                        continue;
                }
            }
            // No food and can't buy - continue anyway
        }

        // v10: Simple zone switching based on level
        // Level 1-9: Men (3 GP), Level 10+: Farmers (9 GP)
        const thievingLevel = currentState.skills.find(s => s.name === 'Thieving')?.baseLevel ?? 1;

        // Determine best zone based on level (no setup needed!)
        const bestZone = getBestZone(thievingLevel);

        // Move to best zone if not there
        if (!isInZone(ctx, bestZone)) {
            const zoneName = bestZone === ZONES.farmers ? 'Farmers' : 'Lumbridge';
            console.log(`Level ${thievingLevel}: Moving to ${zoneName} (${bestZone.coins} GP each)...`);
            const arrived = await walkToWithDoors(ctx, bestZone.x, bestZone.z);
            if (!arrived) {
                console.warn('Failed to reach zone, trying again...');
            }
            continue;
        }

        // Find target in current zone
        const target = findPickpocketTarget(ctx, bestZone.targetPattern);

        if (!target) {
            // No targets nearby - walk TO the zone center (not random)
            // This is where the target spawns, so walking there helps
            console.log(`No targets nearby - walking to ${bestZone === ZONES.farmers ? 'Farmer spawn' : 'zone'}...`);
            await ctx.bot.walkTo(bestZone.x, bestZone.z);
            continue;
        }

        // Attempt pickpocket
        const result = await attemptPickpocket(ctx, target, stats);

        // Log periodic stats every 10 attempts
        if (stats.pickpocketAttempts % 10 === 0 && stats.pickpocketAttempts > 0) {
            logStats(ctx, stats);
        }
    }
}

/**
 * Log current thieving statistics
 */
function logStats(ctx: ScriptContext, stats: ThievingStats): void {
    const state = ctx.sdk.getState();
    if (!state) return;

    const currentThievingXp = state.skills.find(s => s.name === 'Thieving')?.experience ?? 0;
    const xpGained = currentThievingXp - stats.startThievingXp;
    const successRate = stats.pickpocketAttempts > 0
        ? ((stats.successfulPickpockets / stats.pickpocketAttempts) * 100).toFixed(1)
        : '0.0';

    console.log(`--- Stats after ${stats.pickpocketAttempts} attempts ---`);
    console.log(`Success rate: ${successRate}% (${stats.successfulPickpockets}/${stats.pickpocketAttempts})`);
    console.log(`Coins earned: ${stats.coinsEarned} GP`);
    console.log(`Thieving XP gained: +${xpGained}`);
    console.log(`Food eaten: ${stats.foodEaten}`);
    console.log(`Time stunned: ${(stats.stunTimeMs / 1000).toFixed(1)}s`);
}

// Main script
async function main() {
    const username = `tg${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            try {
                await thievingLoop(ctx);
            } finally {
                // Log final stats
                const state = ctx.sdk.getState();
                if (state) {
                    const startThievingXp = 0;  // We start at 0
                    const thieving = state.skills.find(s => s.name === 'Thieving');
                    const coins = ctx.sdk.findInventoryItem(/^coins$/i);

                    console.log('=== Final Results ===');
                    console.log(`Thieving: Level ${thieving?.baseLevel ?? 1} (${thieving?.experience ?? 0} XP)`);
                    console.log(`Total coins in inventory: ${coins?.count ?? 0}`);
                }
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 5 * 60 * 1000,  // 5 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
