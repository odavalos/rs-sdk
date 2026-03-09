/**
 * Fletching Trainer Script
 *
 * Goal: Train Fletching from level 1 to 10+ starting from Lumbridge spawn.
 *
 * Strategy:
 * 1. Pick up knife from ground spawn near Lumbridge castle (SE of castle)
 * 2. Chop trees for logs using bronze axe (included in preset)
 * 3. Use knife on logs to make arrow shafts (level 1-4)
 * 4. At level 5+, can make shortbows for more XP per log
 * 5. Drop arrow shafts/bows when inventory fills
 *
 * XP per action:
 * - Arrow shafts: 5 XP (15 shafts per log)
 * - Shortbow: 5 XP (level 5 required)
 * - Longbow: 10 XP (level 10 required)
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Locations
const KNIFE_SPAWN = { x: 3224, z: 3202 }; // SE of Lumbridge castle (actual spawn location)
const LUMBRIDGE_TREES = { x: 3200, z: 3230 }; // Trees west of Lumbridge castle

// Configuration
const TARGET_LEVEL = 10;

function getFletchingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Fletching')?.baseLevel ?? 1;
}

function getFletchingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Fletching')?.experience ?? 0;
}

function countLogs(ctx: ScriptContext): number {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    return inv.filter(i => /^logs$/i.test(i.name)).length;
}

function hasKnife(ctx: ScriptContext): boolean {
    return !!ctx.sdk.findInventoryItem(/knife/i);
}

function hasAxe(ctx: ScriptContext): boolean {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    const equip = ctx.sdk.getState()?.equipment ?? [];
    return inv.some(i => /axe/i.test(i.name)) || equip.some(i => /axe/i.test(i.name));
}

function getInventoryFreeSlots(ctx: ScriptContext): number {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    return 28 - inv.length;
}

async function dropFletchedItems(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) return;

    // Drop arrow shafts and bows (keep knife, axe, logs)
    const itemsToDrop = state.inventory.filter(item =>
        /arrow shaft|bow/i.test(item.name) && !/shortbow/i.test(item.name) === false
    );

    // Also drop unstrung bows and arrow shafts
    const allDroppable = state.inventory.filter(item =>
        /arrow shaft|shortbow|longbow/i.test(item.name)
    );

    if (allDroppable.length === 0) return;

    console.log(`Dropping ${allDroppable.length} fletched items...`);

    for (const item of allDroppable) {
        await ctx.sdk.sendDropItem(item.slot);
        await sleep(150);
    }
}

async function acquireKnife(ctx: ScriptContext): Promise<boolean> {
    const { bot, sdk } = ctx;

    // First check if knife is already visible from starting position
    let knife = sdk.findGroundItem(/knife/i);
    if (knife) {
        console.log(`Found knife at (${knife.x}, ${knife.z}) from starting position!`);
        const result = await bot.pickupItem(knife);
        if (result.success) {
            console.log('Got knife!');
            return true;
        }
    }

    // Walk to knife spawn area (SE of Lumbridge castle)
    console.log(`Walking to knife spawn at (${KNIFE_SPAWN.x}, ${KNIFE_SPAWN.z})...`);
    const walkResult = await bot.walkTo(KNIFE_SPAWN.x, KNIFE_SPAWN.z);
    console.log(`Walk result: ${walkResult.message}`);

    // Log current position for debugging
    const pos = ctx.sdk.getState()?.player;
    console.log(`Current position after walk: (${pos?.worldX}, ${pos?.worldZ})`);

    // Try to pick up knife from ground - wait for respawn if needed
    for (let attempt = 0; attempt < 15 && !hasKnife(ctx); attempt++) {
        knife = sdk.findGroundItem(/knife/i);
        if (knife) {
            console.log(`Found knife at (${knife.x}, ${knife.z}), picking up...`);
            const result = await bot.pickupItem(knife);
            if (result.success) {
                console.log('Got knife!');
                return true;
            } else {
                console.log(`Pickup failed: ${result.message}`);
            }
        } else {
            // Log nearby ground items for debugging
            const groundItems = ctx.sdk.getState()?.groundItems ?? [];
            if (groundItems.length > 0) {
                console.log(`Nearby ground items: ${groundItems.map(i => `${i.name} at (${i.x},${i.z})`).join(', ')}`);
            }
            console.log(`No knife visible (attempt ${attempt + 1}/15), waiting for respawn...`);
        }
        await sleep(2000); // Wait 2s for potential respawn
    }

    // If no knife on ground, check if we can buy from a shop that sells knives
    // General stores don't always stock knives, but some specialty shops do
    if (!hasKnife(ctx)) {
        console.log('No knife found on ground. Checking for alternative sources...');

        // Check if there's a knife anywhere nearby we missed
        const allGroundItems = ctx.sdk.getState()?.groundItems ?? [];
        console.log(`All visible ground items (${allGroundItems.length}): ${allGroundItems.map(i => i.name).join(', ')}`);
    }

    return hasKnife(ctx);
}

async function chopAndFletch(ctx: ScriptContext): Promise<void> {
    const { bot, sdk } = ctx;

    console.log(`Walking to trees at (${LUMBRIDGE_TREES.x}, ${LUMBRIDGE_TREES.z})...`);
    await bot.walkTo(LUMBRIDGE_TREES.x, LUMBRIDGE_TREES.z);

    let logsChopped = 0;
    let itemsFletched = 0;
    let stuckCount = 0;
    const MAX_STUCK = 10;
    const LOGS_PER_BATCH = 5; // Chop this many logs before fletching

    while (getFletchingLevel(ctx) < TARGET_LEVEL) {
        const state = ctx.sdk.getState();
        if (!state) {
            await sleep(500);
            continue;
        }

        // Dismiss any level-up dialogs
        if (state.dialog.isOpen) {
            console.log('Dismissing dialog...');
            await sdk.sendClickDialog(0);
            await sleep(300);
            continue;
        }

        const freeSlots = getInventoryFreeSlots(ctx);
        const logs = countLogs(ctx);
        const level = getFletchingLevel(ctx);

        // Determine best product based on level
        // Level 1-4: Arrow shafts only
        // Level 5-9: Shortbows (5 XP each)
        // Level 10+: Longbows (10 XP each)
        let product: string;
        if (level >= 10) {
            product = 'long bow';
        } else if (level >= 5) {
            product = 'short bow';
        } else {
            product = 'arrow shafts';
        }

        // Drop fletched items if inventory is getting full
        if (freeSlots <= 2) {
            await dropFletchedItems(ctx);
            continue;
        }

        // If we have logs, fletch them
        if (logs >= LOGS_PER_BATCH || (logs > 0 && freeSlots <= 5)) {
            console.log(`Fletching ${logs} logs into ${product} (level ${level})...`);

            let fletchedThisBatch = 0;
            let consecutiveFailures = 0;

            while (countLogs(ctx) > 0 && consecutiveFailures < 3) {
                // Dismiss any dialogs
                if (ctx.sdk.getState()?.dialog.isOpen) {
                    await sdk.sendClickDialog(0);
                    await sleep(200);
                    continue;
                }

                const xpBefore = getFletchingXp(ctx);
                const result = await bot.fletchLogs(product);

                if (result.success) {
                    fletchedThisBatch++;
                    itemsFletched++;
                    consecutiveFailures = 0;

                    const newLevel = getFletchingLevel(ctx);
                    if (newLevel > level) {
                        console.log(`LEVEL UP! Fletching is now level ${newLevel}`);
                    }
                } else {
                    consecutiveFailures++;
                    console.log(`Fletch failed (${consecutiveFailures}/3): ${result.message}`);
                    await sleep(500);
                }
            }

            if (fletchedThisBatch > 0) {
                console.log(`[Lvl ${getFletchingLevel(ctx)}] Fletched ${fletchedThisBatch} items, Total: ${itemsFletched}`);
            }
            continue;
        }

        // Otherwise, chop more trees
        const tree = sdk.findNearbyLoc(/^tree$/i);

        if (!tree) {
            console.log('No tree nearby, walking to tree area...');
            await bot.walkTo(LUMBRIDGE_TREES.x, LUMBRIDGE_TREES.z);
            stuckCount++;

            if (stuckCount > MAX_STUCK) {
                throw new Error('Unable to find trees after multiple attempts');
            }
            continue;
        }

        // Chop the tree
        const result = await bot.chopTree(tree);

        if (result.success) {
            logsChopped++;
            stuckCount = 0;
            console.log(`[Lvl ${getFletchingLevel(ctx)}] Chopped tree! Logs: ${countLogs(ctx)}, Total chopped: ${logsChopped}`);
        } else {
            console.log(`Chop failed: ${result.message}`);
            stuckCount++;

            if (stuckCount > MAX_STUCK) {
                throw new Error(`Stuck: ${stuckCount} failed chop attempts`);
            }
        }

        await sleep(200);
    }

    console.log(`=== GOAL ACHIEVED: Fletching level ${getFletchingLevel(ctx)}! ===`);
}

// Main script
async function main() {
    const username = `fl${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {

            console.log('=== Fletching Trainer ===');
            console.log(`Goal: Level ${TARGET_LEVEL}`);

            // Wait for state to initialize
            await sleep(2000);

            const state = ctx.sdk.getState();
            if (!state?.player) {
                console.error('No player state');
                return;
            }

            console.log(`Starting at (${state.player.worldX}, ${state.player.worldZ})`);
            console.log(`Current Fletching level: ${getFletchingLevel(ctx)}`);

            // Dismiss any startup dialogs
            await ctx.bot.dismissBlockingUI();

            // Step 1: Get a knife
            if (!hasKnife(ctx)) {
                console.log('No knife found, acquiring one...');
                const gotKnife = await acquireKnife(ctx);
                if (!gotKnife) {
                    console.error('Failed to acquire knife, cannot continue');
                    return;
                }
            } else {
                console.log('Already have a knife!');
            }

            // Verify we have an axe
            if (!hasAxe(ctx)) {
                console.error('No axe found! The preset should include a bronze axe.');
                return;
            }
            console.log('Have axe - ready to chop trees');

            // Step 2: Chop trees and fletch until target level
            console.log('Starting fletching training...');
            await chopAndFletch(ctx);

            console.log('=== Script Complete ===');
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 10 * 60 * 1000,  // 10 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);

// Helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
