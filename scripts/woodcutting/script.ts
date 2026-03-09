/**
 * Woodcutting Trainer Script
 *
 * Goal: Train Woodcutting to level 10+ starting from a fresh Lumbridge spawn.
 *
 * Strategy:
 * 1. Walk to Bob's Axes in Lumbridge
 * 2. Buy a bronze axe (16gp - fresh accounts have 25gp)
 * 3. Walk to trees near Lumbridge
 * 4. Chop trees until level 10
 * 5. Drop logs when inventory fills
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Locations
const BOBS_AXES = { x: 3230, z: 3203 };
const LUMBRIDGE_TREES = { x: 3200, z: 3230 }; // Trees west of Lumbridge castle

// Configuration
const TARGET_LEVEL = 10;
const BRONZE_AXE_COST = 16;

function getWoodcuttingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.baseLevel ?? 1;
}

function getWoodcuttingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.experience ?? 0;
}

function countLogs(ctx: ScriptContext): number {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    return inv.filter(i => /logs/i.test(i.name)).length;
}

function hasAxe(ctx: ScriptContext): boolean {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    const equip = ctx.sdk.getState()?.equipment ?? [];
    return inv.some(i => /axe/i.test(i.name)) || equip.some(i => /axe/i.test(i.name));
}

function getCoins(ctx: ScriptContext): number {
    const coins = ctx.sdk.getState()?.inventory.find(i => /coins/i.test(i.name));
    return coins?.count ?? 0;
}

async function dropAllLogs(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) return;

    const logsItems = state.inventory.filter(item => /logs/i.test(item.name));
    console.log(`Dropping ${logsItems.length} logs...`);

    for (const item of logsItems) {
        await ctx.sdk.sendDropItem(item.slot);
        await new Promise(r => setTimeout(r, 150));
    }
}

async function buyAxeFromBob(ctx: ScriptContext): Promise<boolean> {
    const { bot, sdk } = ctx;

    // Check if we have enough coins
    const gp = getCoins(ctx);
    console.log(`Current GP: ${gp}`);

    if (gp < BRONZE_AXE_COST) {
        console.error(`Not enough GP for bronze axe (need ${BRONZE_AXE_COST}, have ${gp})`);
        return false;
    }

    // Walk to Bob's Axes
    console.log(`Walking to Bob's Axes at (${BOBS_AXES.x}, ${BOBS_AXES.z})...`);
    await bot.walkTo(BOBS_AXES.x, BOBS_AXES.z);

    // Dismiss any dialogs
    await bot.dismissBlockingUI();

    // Log nearby NPCs for debugging
    const state = ctx.sdk.getState();
    console.log(`Position: (${state?.player?.worldX}, ${state?.player?.worldZ})`);
    const nearbyNpcs = state?.nearbyNpcs?.slice(0, 5) ?? [];
    console.log(`Nearby NPCs: ${nearbyNpcs.map(n => n.name).join(', ')}`);

    // Open Bob's shop
    console.log('Opening shop...');
    let shopResult = await bot.openShop(/bob/i);

    if (!shopResult.success) {
        // Try finding any NPC with trade option
        console.log('Bob not found by name, looking for trade option...');
        const npcWithTrade = state?.nearbyNpcs.find(n =>
            n.optionsWithIndex.some(o => /trade/i.test(o.text))
        );

        if (npcWithTrade) {
            console.log(`Found tradeable NPC: ${npcWithTrade.name}`);
            const tradeOpt = npcWithTrade.optionsWithIndex.find(o => /trade/i.test(o.text));
            if (tradeOpt) {
                await sdk.sendInteractNpc(npcWithTrade.index, tradeOpt.opIndex);
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    // Check if shop opened
    await new Promise(r => setTimeout(r, 500));
    const shopState = ctx.sdk.getState()?.shop;

    if (!shopState?.isOpen) {
        console.error('Failed to open shop');
        return false;
    }

    // Log shop inventory
    console.log(`Shop open with ${shopState.shopItems.length} items`);
    const axes = shopState.shopItems.filter(i => /axe/i.test(i.name));
    for (const axe of axes) {
        console.log(`  ${axe.name} - ${axe.buyPrice}gp (stock: ${axe.count})`);
    }

    // Buy bronze axe
    console.log('Buying bronze axe...');
    const buyResult = await bot.buyFromShop(/bronze axe/i, 1);
    console.log(`Buy result: ${buyResult.message}`);

    // Close shop by walking away
    await sdk.sendWalk(3225, 3210, true);
    await new Promise(r => setTimeout(r, 1000));

    // Verify we got the axe
    const gotAxe = hasAxe(ctx);
    if (gotAxe) {
        console.log('SUCCESS: Got bronze axe!');
    } else {
        console.error('Failed to buy bronze axe');
    }

    return gotAxe;
}

async function chopTrees(ctx: ScriptContext): Promise<void> {
    const { bot, sdk } = ctx;

    console.log(`Walking to trees at (${LUMBRIDGE_TREES.x}, ${LUMBRIDGE_TREES.z})...`);
    await bot.walkTo(LUMBRIDGE_TREES.x, LUMBRIDGE_TREES.z);

    let lastXp = getWoodcuttingXp(ctx);
    let logsChopped = 0;
    let stuckCount = 0;
    const MAX_STUCK = 10;

    while (getWoodcuttingLevel(ctx) < TARGET_LEVEL) {
        const state = ctx.sdk.getState();
        if (!state) {
            await new Promise(r => setTimeout(r, 500));
            continue;
        }

        // Dismiss any level-up dialogs
        if (state.dialog.isOpen) {
            console.log('Dismissing dialog...');
            await sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
            continue;
        }

        // Drop logs if inventory is getting full
        if (state.inventory.length >= 26) {
            await dropAllLogs(ctx);
            continue;
        }

        // Find nearest tree
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

        const currentXp = getWoodcuttingXp(ctx);
        if (currentXp > lastXp) {
            logsChopped++;
            stuckCount = 0; // Reset stuck counter on success
            console.log(`[Lvl ${getWoodcuttingLevel(ctx)}] Chopped tree! Logs: ${countLogs(ctx)}, Total: ${logsChopped}, XP: ${currentXp}`);
            lastXp = currentXp;
        } else if (!result.success) {
            console.log(`Chop failed: ${result.message}`);
            stuckCount++;

            if (stuckCount > MAX_STUCK) {
                throw new Error(`Stuck: ${stuckCount} failed chop attempts`);
            }
        }

        // Small delay between actions
        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`=== GOAL ACHIEVED: Woodcutting level ${getWoodcuttingLevel(ctx)}! ===`);
}

// Main script
async function main() {
    // Create fresh account
    const username = `wc${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {

            console.log('=== Woodcutting Trainer ===');
            console.log(`Goal: Level ${TARGET_LEVEL}`);

            // Wait for state to initialize
            await new Promise(r => setTimeout(r, 2000));

            const state = ctx.sdk.getState();
            if (!state?.player) {
                console.error('No player state');
                return;
            }

            console.log(`Starting at (${state.player.worldX}, ${state.player.worldZ})`);
            console.log(`Current Woodcutting level: ${getWoodcuttingLevel(ctx)}`);

            // Dismiss any startup dialogs
            await ctx.bot.dismissBlockingUI();

            // Step 1: Get an axe if we don't have one
            if (!hasAxe(ctx)) {
                console.log('No axe found, buying from Bob...');
                const gotAxe = await buyAxeFromBob(ctx);
                if (!gotAxe) {
                    console.error('Failed to acquire axe, cannot continue');
                    return;
                }
            } else {
                console.log('Already have an axe!');
            }

            // Step 2: Chop trees until target level
            console.log('Starting woodcutting training...');
            await chopTrees(ctx);

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
