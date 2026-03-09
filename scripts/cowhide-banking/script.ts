/**
 * Cow Hide Banking Script
 *
 * Goal: Collect and bank as many cow hides as possible in 15 minutes.
 *
 * Strategy:
 * - Start at Lumbridge (standard post-tutorial spawn)
 * - Equip combat gear (bronze sword + wooden shield)
 * - Walk to Lumbridge cow field
 * - Kill cows, pick up cow hides
 * - When inventory is full, walk to Lumbridge Castle bank and deposit
 * - Track: kills, hides collected, hides banked, bank trips
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc } from '../../sdk/types';

// Locations
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3270 },           // Lumbridge cow field (east of castle)
    LUMBRIDGE_BANK: { x: 3208, z: 3220 },      // Lumbridge Castle bank (top floor, level 2)
    LUMBRIDGE_CASTLE_ENTRANCE: { x: 3210, z: 3217 },  // Castle main entrance
    LUMBRIDGE_STAIRS_GROUND: { x: 3206, z: 3208 },    // Stairs inside castle ground floor
};

// Configuration
const INVENTORY_THRESHOLD = 24;  // Bank when inventory has this many items
const MAX_HIDES_BEFORE_BANK = 8;  // Force bank trip after collecting this many hides (lowered for faster iteration)

// Statistics tracking
interface HideStats {
    kills: number;
    hidesCollected: number;
    hidesBanked: number;
    bankTrips: number;
    startTime: number;
    lastProgressTime: number;
}

/**
 * Find the best cow to attack
 * - Filters out cows already in combat with someone else
 * - Prefers idle cows over cows in combat
 * - Sorts by distance
 */
function findBestCow(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    const cows = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))
        .filter(npc => npc.options.some(o => /attack/i.test(o)))
        // Filter out cows already fighting someone else
        .filter(npc => {
            if (npc.targetIndex === -1) return true;
            return !npc.inCombat;
        })
        .sort((a, b) => {
            // Prefer cows not in combat
            if (a.inCombat !== b.inCombat) {
                return a.inCombat ? 1 : -1;
            }
            // Then by distance
            return a.distance - b.distance;
        });

    return cows[0] ?? null;
}

/**
 * Wait for combat to complete
 */
async function waitForCombatEnd(
    ctx: ScriptContext,
    targetNpc: NearbyNpc,
    stats: HideStats
): Promise<'kill' | 'fled' | 'lost_target'> {
    let combatStarted = false;
    let ticksSinceCombatEnded = 0;
    let loopCount = 0;

    const maxWaitMs = 30000;
    const startTime = Date.now();

    // Initial delay for attack animation
    await new Promise(r => setTimeout(r, 800));

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, 400));
        loopCount++;
        const state = ctx.sdk.getState();
        if (!state) return 'lost_target';

        // CRITICAL: Dismiss any dialogs during combat (level-up messages)
        // Without this, dialogs block game responses and cause server timeouts
        if (state.dialog.isOpen) {
            console.log('Dismissing dialog during combat...');
            await ctx.sdk.sendClickDialog(0);
            continue;
        }

        const currentTick = state.tick;

        // Find our target cow
        const target = state.nearbyNpcs.find(n => n.index === targetNpc.index);

        if (!target) {
            // Cow disappeared - likely died
            if (combatStarted || loopCount >= 2) {
                stats.kills++;
                return 'kill';
            }
            return 'lost_target';
        }

        // Check cow health
        if (target.maxHp > 0 && target.hp === 0) {
            stats.kills++;
            return 'kill';
        }

        // Check combat status
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

/**
 * Pick up cow hides from the ground
 */
async function pickupHides(ctx: ScriptContext, stats: HideStats): Promise<number> {
    let pickedUp = 0;
    const state = ctx.sdk.getState();
    if (!state) return 0;

    // Check inventory space
    if (state.inventory.length >= 28) {
        return 0;
    }

    const groundItems = ctx.sdk.getGroundItems()
        .filter(i => /cow\s*hide/i.test(i.name))
        .filter(i => i.distance <= 8)
        .sort((a, b) => a.distance - b.distance);

    for (const item of groundItems.slice(0, 3)) {
        if (ctx.sdk.getState()!.inventory.length >= 28) break;

        console.log(`Picking up ${item.name}...`);
        const result = await ctx.bot.pickupItem(item);
        if (result.success) {
            pickedUp++;
            stats.hidesCollected++;
        }
        await new Promise(r => setTimeout(r, 300));
    }

    return pickedUp;
}

/**
 * Bank the collected hides at Lumbridge Castle bank
 */
async function bankHides(ctx: ScriptContext, stats: HideStats): Promise<boolean> {
    console.log('=== Banking Trip ===');
    stats.bankTrips++;

    const currentState = ctx.sdk.getState();
    const currentLevel = currentState?.player?.level ?? 0;
    const hidesBeforeBank = currentState?.inventory.filter(i => /cow\s*hide/i.test(i.name)).length ?? 0;

    console.log(`Current floor level: ${currentLevel}, hides in inventory: ${hidesBeforeBank}`);

    // If we're at ground level (0), we need to go up stairs
    if (currentLevel === 0) {
        console.log('Walking to castle entrance...');
        await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_CASTLE_ENTRANCE.x, LOCATIONS.LUMBRIDGE_CASTLE_ENTRANCE.z);

        console.log('Walking to castle stairs...');
        await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_STAIRS_GROUND.x, LOCATIONS.LUMBRIDGE_STAIRS_GROUND.z);

        // Climb up stairs to level 1
        console.log('Climbing to first floor...');
        const nearbyLocs = ctx.sdk.getState()?.nearbyLocs ?? [];
        console.log(`Nearby locs: ${nearbyLocs.slice(0, 5).map(l => l.name).join(', ')}`);

        const stairs1 = nearbyLocs.find(l => /staircase/i.test(l.name));
        if (stairs1) {
            console.log(`Found stairs: ${stairs1.name} at (${stairs1.x}, ${stairs1.z})`);
            console.log(`Options: ${stairs1.optionsWithIndex.map(o => o.text).join(', ')}`);
            const climbOpt = stairs1.optionsWithIndex.find(o => /climb.?up/i.test(o.text));
            if (climbOpt) {
                console.log(`Using climb option: ${climbOpt.text}`);
                await ctx.sdk.sendInteractLoc(stairs1.x, stairs1.z, stairs1.id, climbOpt.opIndex);
                await new Promise(r => setTimeout(r, 2000));
                } else {
                console.warn('No climb-up option found on stairs');
            }
        } else {
            console.warn('No staircase found nearby!');
        }
    }

    // Check if we're on first floor (level 1), need to go to level 2
    const midState = ctx.sdk.getState();
    const midLevel = midState?.player?.level ?? 0;
    console.log(`After first climb, floor level: ${midLevel}`);

    if (midLevel === 1) {
        // Find stairs to climb to level 2
        console.log('Climbing to second floor (bank floor)...');
        const stairs2 = ctx.sdk.getState()?.nearbyLocs.find(l => /staircase/i.test(l.name));
        if (stairs2) {
            const climbOpt = stairs2.optionsWithIndex.find(o => /climb.?up/i.test(o.text));
            if (climbOpt) {
                await ctx.sdk.sendInteractLoc(stairs2.x, stairs2.z, stairs2.id, climbOpt.opIndex);
                await new Promise(r => setTimeout(r, 1500));
                }
        }
    }

    // Now we should be at level 2, walk to bank area
    console.log('Walking to bank...');
    await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_BANK.x, LOCATIONS.LUMBRIDGE_BANK.z);

    // Open bank - find bank booth or banker
    console.log('Opening bank...');
    let bankOpened = false;

    // Try bank booth first
    const bankBooth = ctx.sdk.getState()?.nearbyLocs.find(l => /bank booth|bank chest/i.test(l.name));
    if (bankBooth) {
        const bankOpt = bankBooth.optionsWithIndex.find(o => /^bank$/i.test(o.text)) ||
                       bankBooth.optionsWithIndex.find(o => /use/i.test(o.text)) ||
                       bankBooth.optionsWithIndex[0];
        if (bankOpt) {
            console.log(`Using bank booth option: ${bankOpt.text}`);
            await ctx.sdk.sendInteractLoc(bankBooth.x, bankBooth.z, bankBooth.id, bankOpt.opIndex);
            await new Promise(r => setTimeout(r, 1000));

            // Wait for interface to open
            for (let i = 0; i < 10; i++) {
                const state = ctx.sdk.getState();
                if (state?.interface?.isOpen) {
                    bankOpened = true;
                    console.log('Bank interface opened!');
                    break;
                }
                if (state?.dialog?.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        }
    }

    // If no bank booth, try banker NPC
    if (!bankOpened) {
        const banker = ctx.sdk.findNearbyNpc(/banker/i);
        if (banker) {
            const bankOpt = banker.optionsWithIndex.find(o => /bank/i.test(o.text));
            if (bankOpt) {
                console.log(`Using banker: ${banker.name}`);
                await ctx.sdk.sendInteractNpc(banker.index, bankOpt.opIndex);
                await new Promise(r => setTimeout(r, 1000));

                // Wait for interface to open
                for (let i = 0; i < 10; i++) {
                    const state = ctx.sdk.getState();
                    if (state?.interface?.isOpen) {
                        bankOpened = true;
                        console.log('Bank interface opened!');
                        break;
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        }
    }

    if (!bankOpened) {
        console.warn('Failed to open bank interface - aborting banking trip');
        // Return to cow field without depositing
        await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
        console.log('=== Banking failed, back at cow field ===');
        return false;
    }


    // Count hides before depositing
    const hidesBefore = ctx.sdk.getState()?.inventory.filter(i => /cow\s*hide/i.test(i.name)).length ?? 0;

    // Deposit all cow hides
    const hides = ctx.sdk.getState()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];

    for (const hide of hides) {
        console.log(`Depositing ${hide.name} from slot ${hide.slot}...`);
        await ctx.sdk.sendBankDeposit(hide.slot, hide.count);
        await new Promise(r => setTimeout(r, 200));
    }

    // Wait for items to leave inventory
    await new Promise(r => setTimeout(r, 800));

    // Verify deposits worked by checking inventory
    const hidesAfter = ctx.sdk.getState()?.inventory.filter(i => /cow\s*hide/i.test(i.name)).length ?? 0;
    const actualDeposited = hidesBefore - hidesAfter;

    if (actualDeposited > 0) {
        stats.hidesBanked += actualDeposited;
        console.log(`Deposited ${actualDeposited} hides. Total banked: ${stats.hidesBanked}`);
    } else {
        console.warn(`Deposit failed - hides still in inventory (${hidesAfter})`);
    }

    // Close bank interface by pressing escape or clicking close
    // The interface will close when we walk away anyway
    console.log('Returning to cow field...');

    // Climb down to level 1
    const stairs = ctx.sdk.getState()?.nearbyLocs.find(l => /staircase/i.test(l.name));
    if (stairs) {
        const downOpt = stairs.optionsWithIndex.find(o => /climb.?down/i.test(o.text));
        if (downOpt) {
            await ctx.sdk.sendInteractLoc(stairs.x, stairs.z, stairs.id, downOpt.opIndex);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // Climb down to level 0
    const stairs2 = ctx.sdk.getState()?.nearbyLocs.find(l => /staircase/i.test(l.name));
    if (stairs2) {
        const downOpt = stairs2.optionsWithIndex.find(o => /climb.?down/i.test(o.text));
        if (downOpt) {
            await ctx.sdk.sendInteractLoc(stairs2.x, stairs2.z, stairs2.id, downOpt.opIndex);
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    // Walk back to cow field
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);

    console.log('=== Back at cow field ===');
    return true;
}

/**
 * Log current statistics
 */
function logStats(ctx: ScriptContext, stats: HideStats): void {
    const elapsed = Math.floor((Date.now() - stats.startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;

    const hidesPerMinute = elapsed > 0 ? (stats.hidesBanked / (elapsed / 60)).toFixed(1) : '0';

    console.log(`--- Stats (${minutes}m ${seconds}s) ---`);
    console.log(`Kills: ${stats.kills}, Hides collected: ${stats.hidesCollected}`);
    console.log(`Hides banked: ${stats.hidesBanked}, Bank trips: ${stats.bankTrips}`);
    console.log(`Rate: ${hidesPerMinute} hides/min`);
}

/**
 * Check if we should clear inventory (drop hides to make space)
 */
function shouldDropHides(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state) return false;

    // Drop hides if inventory is getting full
    return state.inventory.length >= INVENTORY_THRESHOLD;
}

/**
 * Drop cow hides to make inventory space
 */
async function dropHides(ctx: ScriptContext, stats: HideStats): Promise<void> {
    console.log('=== Dropping hides to make space ===');

    const hides = ctx.sdk.getState()?.inventory.filter(i => /cow\s*hide/i.test(i.name)) ?? [];

    for (const hide of hides) {
        console.log(`Dropping ${hide.name}...`);
        await ctx.sdk.sendDropItem(hide.slot);
        stats.hidesCollected++;  // Count as collected even though dropped
        await new Promise(r => setTimeout(r, 150));
    }

    console.log(`Dropped ${hides.length} hides. Continuing training...`);
}

/**
 * Main cow hide collecting loop
 */
async function cowhideLoop(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) throw new Error('No initial state');

    const stats: HideStats = {
        kills: 0,
        hidesCollected: 0,
        hidesBanked: 0,
        bankTrips: 0,
        startTime: Date.now(),
        lastProgressTime: Date.now(),
    };

    console.log('=== Cow Hide Banking Script Started ===');
    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);

    // Equip combat gear
    const sword = ctx.sdk.findInventoryItem(/bronze sword/i);
    if (sword) {
        console.log('Equipping bronze sword...');
        await ctx.bot.equipItem(sword);
    }

    const shield = ctx.sdk.findInventoryItem(/wooden shield/i);
    if (shield) {
        console.log('Equipping wooden shield...');
        await ctx.bot.equipItem(shield);
    }

    // Set combat style to Aggressive for Strength XP
    console.log('Setting combat style to Aggressive (Strength training)...');
    await ctx.sdk.sendSetCombatStyle(1);  // 0=accurate, 1=aggressive, 2=defensive, 3=controlled

    // Walk to cow field
    console.log('Walking to cow field...');
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);

    let lastStatsLog = 0;

    // Main loop
    while (true) {
        const currentState = ctx.sdk.getState();
        if (!currentState) {
            console.warn('Lost game state');
            break;
        }

        // Dismiss any blocking dialogs (level-up messages)
        if (currentState.dialog.isOpen) {
            console.log('Dismissing dialog...');
            await ctx.sdk.sendClickDialog(0);
            continue;
        }

        // Check HP and eat food if needed
        const hp = currentState.skills.find(s => s.name === 'Hitpoints');
        if (hp && hp.level < hp.baseLevel * 0.5) {
            // Try to eat available food
            const food = ctx.sdk.findInventoryItem(/^(bread|shrimps?|cooked meat|anchovies|trout|salmon|lobster|swordfish|kebab)$/i);
            if (food) {
                console.log(`HP low (${hp.level}/${hp.baseLevel}) - eating ${food.name}`);
                await ctx.bot.eatFood(food);
                    continue;
            } else {
                console.warn(`HP low (${hp.level}/${hp.baseLevel}) but no food!`);
            }
        }

        // Log stats periodically (every 10 kills)
        if (stats.kills > 0 && stats.kills % 10 === 0 && stats.kills !== lastStatsLog) {
            lastStatsLog = stats.kills;
            logStats(ctx, stats);
        }

        // Check if we need to drop hides to make space (simplified - no banking for now)
        if (shouldDropHides(ctx)) {
            await dropHides(ctx, stats);
            continue;
        }

        // Try to pick up any nearby hides first
        await pickupHides(ctx, stats);

        // Find a cow to attack
        const cow = findBestCow(ctx);
        if (!cow) {
            // No cows nearby, walk to cow field center
            console.log('No cows nearby, walking to cow field...');
            await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
            continue;
        }

        // Check if already in combat with this cow
        const playerCombat = currentState.player?.combat;
        if (playerCombat?.inCombat && playerCombat.targetIndex === cow.index) {
            const result = await waitForCombatEnd(ctx, cow, stats);
            console.log(`Combat ended: ${result}`);
            continue;
        }

        // Attack the cow
        console.log(`Attacking ${cow.name} (dist: ${cow.distance})`);
        const attackResult = await ctx.bot.attackNpc(cow);

        if (!attackResult.success) {
            console.warn(`Attack failed: ${attackResult.message}`);

            // Try to open gate if blocked
            if (attackResult.reason === 'out_of_reach') {
                console.log('Trying to open gate...');
                const gateResult = await ctx.bot.openDoor(/gate/i);
                if (gateResult.success) {
                    console.log('Gate opened!');
                }
            }
            continue;
        }

        // Wait for combat to complete
        const combatResult = await waitForCombatEnd(ctx, cow, stats);

        if (combatResult === 'kill') {
            console.log(`Kill #${stats.kills}!`);
            // Immediately try to pick up the hide
            await new Promise(r => setTimeout(r, 600));
            await pickupHides(ctx, stats);
        }

    }
}

// Main script
async function main() {
    // Create fresh account
    const username = `ch${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            try {
                await cowhideLoop(ctx);
            } finally {
                // Log final stats
                const state = ctx.sdk.getState();
                if (state) {
                    console.log('=== Final Results ===');
                    const hides = state.inventory.filter(i => /cow\s*hide/i.test(i.name));
                    console.log(`Hides in inventory: ${hides.length}`);
                    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);
                }
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 15 * 60 * 1000,  // 15 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
