/**
 * Fletching GP Maximizer
 *
 * Strategy: Normal logs until level 20, then oaks
 * - Chop normal trees -> fletch longbows -> sell
 * - At level 20+, switch to oak trees -> oak shortbows/longbows
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets, Items, Locations } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Locations
const NORMAL_TREES_AREA = { x: 3200, z: 3230 };
const OAK_TREES_AREA = { x: 3203, z: 3243 };
const GENERAL_STORE = Locations.LUMBRIDGE_SHOP;

const LOGS_BEFORE_FLETCH = 6;
const MIN_LOGS_TO_FLETCH = 4;

type FletchProduct = 'arrow shafts' | 'short bow' | 'long bow' | 'oak short bow' | 'oak long bow';

function getBestProduct(fletchingLevel: number, logType: 'normal' | 'oak'): FletchProduct | null {
    if (logType === 'oak') {
        if (fletchingLevel >= 25) return 'oak long bow';
        if (fletchingLevel >= 20) return 'oak short bow';
        return null; // Can't fletch oaks below 20
    }
    if (fletchingLevel >= 10) return 'long bow';
    if (fletchingLevel >= 5) return 'short bow';
    return 'arrow shafts';
}

// Track GP earned
interface GPTracker {
    startingGP: number;
    currentGP: number;
    itemsSold: number;
    logsChopped: number;
    productsFletched: number;
    sellCycles: number;
    gpPerCycle: number[];  // Track GP earned each sell cycle
}

function getFletchingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Fletching')?.baseLevel ?? 1;
}

function getWoodcuttingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.baseLevel ?? 1;
}

function getGP(ctx: ScriptContext): number {
    const coins = ctx.sdk.findInventoryItem(/coins/i);
    return coins?.count ?? 0;
}

function countLogs(ctx: ScriptContext): { normal: number; oak: number; total: number } {
    // Logs don't stack - count all log items in inventory
    const inv = ctx.sdk.getState()?.inventory ?? [];
    const normal = inv.filter(i => /^logs$/i.test(i.name)).length;
    const oak = inv.filter(i => /^oak logs$/i.test(i.name)).length;
    return { normal, oak, total: normal + oak };
}

function countSellableItems(ctx: ScriptContext): number {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    // Count arrow shafts (15 per log) and unstrung bows (1 per log)
    // Include oak shortbow and oak longbow
    return inv.filter(i =>
        /arrow shaft|shortbow|longbow/i.test(i.name)
    ).reduce((sum, i) => sum + i.count, 0);
}

function getInventoryFreeSlots(ctx: ScriptContext): number {
    const inv = ctx.sdk.getState()?.inventory ?? [];
    return 28 - inv.length;
}

function logStats(ctx: ScriptContext, tracker: GPTracker, label: string): void {
    const level = getFletchingLevel(ctx);
    const gpEarned = tracker.currentGP - tracker.startingGP;
    const cyclesStr = tracker.gpPerCycle.length > 0
        ? ` | Cycles: [${tracker.gpPerCycle.join(', ')}]`
        : '';
    console.log(`[${label}] GP: ${gpEarned} | Fletch: ${level} | Logs: ${tracker.logsChopped} | Fletched: ${tracker.productsFletched} | Sold: ${tracker.itemsSold}${cyclesStr}`);
}

async function fletchingGP(ctx: ScriptContext) {
    const { bot, sdk } = ctx;

    // Initialize tracking
    const tracker: GPTracker = {
        startingGP: getGP(ctx),
        currentGP: getGP(ctx),
        itemsSold: 0,
        logsChopped: 0,
        productsFletched: 0,
        sellCycles: 0,
        gpPerCycle: [],
    };

    logStats(ctx, tracker, 'START');

    // First: Find and pick up a knife from the ground
    const hasKnife = () => !!sdk.findInventoryItem(/knife/i);
    if (!hasKnife()) {
        console.log('Looking for knife on ground...');

        // Try to find and pickup knife
        for (let attempt = 0; attempt < 5 && !hasKnife(); attempt++) {
            const knife = sdk.findGroundItem(/knife/i);
            if (knife) {
                console.log(`Found knife at (${knife.x}, ${knife.z}), picking up...`);
                const result = await bot.pickupItem(knife);
                if (result.success) {
                    console.log('Got knife!');
                    break;
                } else {
                    console.log(`Pickup failed: ${result.message}`);
                }
            } else {
                console.log(`No knife visible (attempt ${attempt + 1})`);
            }
            await sleep(1000);
        }

        if (!hasKnife()) {
            console.log('WARNING: No knife found - will try to continue anyway');
        }
    }

    // Main loop: Chop -> Fletch -> Sell
    while (true) {
        const state = ctx.sdk.getState();
        if (!state?.player) {
            await sleep(500);
            continue;
        }

        // Eat if HP is low (survive random events)
        const hpSkill = sdk.getSkill('Hitpoints');
        const currentHp = hpSkill?.level ?? 10;
        const maxHp = hpSkill?.baseLevel ?? 10;
        if (currentHp < maxHp - 3) {
            const food = sdk.findInventoryItem(/bread|shrimp|fish/i);
            if (food) {
                console.log(`HP low (${currentHp}/${maxHp}), eating ${food.name}...`);
                await bot.eatFood(food);
            }
        }

        // Close shop first if open (before checking dialogs)
        if (state.shop.isOpen) {
            // First dismiss any dialogs that might be blocking
            if (state.dialog.isOpen) {
                await sdk.sendClickDialog(0);
                await sleep(300);
            }
            // Try closing shop up to 5 times, then walk away to force close
            for (let attempt = 0; attempt < 5; attempt++) {
                console.log(`Closing shop (attempt ${attempt + 1})...`);
                await sdk.sendCloseShop();
                await sleep(600);
                if (!ctx.sdk.getState()?.shop.isOpen) {
                    console.log('Shop closed successfully');
                    break;
                }
            }
            // If STILL open after 5 attempts, walk away to force close
            if (ctx.sdk.getState()?.shop.isOpen) {
                console.log('Shop stuck, walking away to force close...');
                await bot.walkTo(NORMAL_TREES_AREA.x, NORMAL_TREES_AREA.z);
            }
            continue;
        }

        // Dismiss level-up dialogs (NOT shop interface)
        if (state.dialog.isOpen) {
            await sdk.sendClickDialog(0);
            await sleep(250);
            continue;
        }

        const freeSlots = getInventoryFreeSlots(ctx);
        const logs = countLogs(ctx);
        const sellableCount = countSellableItems(ctx);
        const fletchLevel = getFletchingLevel(ctx);

        // Log state every time we have logs (for debugging)
        if (logs.total >= MIN_LOGS_TO_FLETCH) {
            console.log(`Decision: ${logs.oak} oak + ${logs.normal} normal logs, ${sellableCount} sellable, ${freeSlots} free slots`);
        }

        // Decision tree:
        // 1. If we have sellable items and inventory is getting full, go sell
        // 2. If we have enough logs, fletch them
        // 3. Otherwise, chop more trees

        if (sellableCount > 0 && (freeSlots < 8 || sellableCount >= 6)) {
            // === SELLING PHASE ===
            console.log(`Selling ${sellableCount} items...`);

            // Walk to general store
            await bot.walkTo(GENERAL_STORE.x, GENERAL_STORE.z);

            // Open shop
            const shopResult = await bot.openShop(/shop.*keeper|general/i);
            if (!shopResult.success) {
                console.log(`Failed to open shop: ${shopResult.message}`);
                await sleep(1000);
                continue;
            }

            // Sell all fletched products - oak longbows first (most valuable)
            const sellPatterns = [/oak longbow/i, /oak shortbow/i, /longbow/i, /shortbow/i, /arrow shaft/i];
            const gpBefore = getGP(ctx);
            let totalItemsSold = 0;

            for (const pattern of sellPatterns) {
                let attempts = 0;
                while (attempts < 20) { // Max 20 attempts per pattern
                    attempts++;
                    const currentState = ctx.sdk.getState();
                    if (!currentState?.shop.isOpen) break;

                    const item = currentState.shop.playerItems.find(i => pattern.test(i.name));
                    if (!item || item.count === 0) break;

                    const gpBeforeSell = getGP(ctx);
                    const sellResult = await bot.sellToShop(item, 'all');

                    // Check if GP increased (actual success) even if sellResult reports failure
                    const gpAfterSell = getGP(ctx);
                    if (gpAfterSell > gpBeforeSell || sellResult.success) {
                        const gpGained = gpAfterSell - gpBeforeSell;
                        const sold = sellResult.amountSold ?? 1;
                        totalItemsSold += sold;
                        tracker.itemsSold += sold;
                        console.log(`Sold ${item.name} (+${gpGained} GP)`);
                    } else if (sellResult.rejected) {
                        console.log(`Shop won't buy ${item.name}`);
                        break;
                    } else {
                        // No GP gain and not successful, move to next pattern
                        break;
                    }
                    await sleep(100);
                }
            }

            const gpAfter = getGP(ctx);
            const cycleGP = gpAfter - gpBefore;
            tracker.sellCycles++;
            tracker.gpPerCycle.push(cycleGP);
            console.log(`Sell cycle #${tracker.sellCycles} complete: +${cycleGP} GP, ${totalItemsSold} items`);

            // Log saturation warning if GP per cycle is dropping significantly
            if (tracker.gpPerCycle.length >= 2) {
                const lastCycleGP = tracker.gpPerCycle[tracker.gpPerCycle.length - 2];
                if (lastCycleGP !== undefined && cycleGP < lastCycleGP * 0.6) {
                    console.log(`WARNING: Shop saturation detected: GP dropped from ${lastCycleGP} to ${cycleGP}`);
                }
            }

            // Dismiss any level-up dialogs that appeared during selling
            for (let i = 0; i < 5; i++) {
                const currentState = ctx.sdk.getState();
                if (currentState?.dialog.isOpen) {
                    console.log('Dismissing dialog before closing shop...');
                    await sdk.sendClickDialog(0);
                    await sleep(300);
                } else {
                    break;
                }
            }

            // Close shop before checking GP
            await bot.closeShop();
            await sleep(500);

            // If shop still open, force close
            if (ctx.sdk.getState()?.shop.isOpen) {
                console.log('Shop still open after closeShop, forcing close...');
                await sdk.sendCloseShop();
                await sleep(500);
            }

            // Update GP tracking
            tracker.currentGP = getGP(ctx);
            const gpEarned = tracker.currentGP - tracker.startingGP;
            console.log(`Total GP earned so far: ${gpEarned}`);
            logStats(ctx, tracker, 'AFTER SELL');

        } else if (logs.total >= MIN_LOGS_TO_FLETCH && (logs.total >= LOGS_BEFORE_FLETCH || freeSlots <= 3)) {
            // === FLETCHING PHASE ===
            // First dismiss any dialogs
            for (let i = 0; i < 3; i++) {
                if (ctx.sdk.getState()?.dialog.isOpen) {
                    await sdk.sendClickDialog(0);
                    await sleep(300);
                } else {
                    break;
                }
            }

            // Use oak logs only if we can fletch them (level 20+)
            const useOakLogs = fletchLevel >= 20 && logs.oak > 0;
            const logType = useOakLogs ? 'oak' : 'normal';

            // Skip if we only have oak logs but can't fletch them
            if (logs.normal === 0 && !useOakLogs) {
                console.log(`Can't fletch oak logs at level ${fletchLevel}, need 20+`);
                await sleep(500);
                continue;
            }

            const product = getBestProduct(fletchLevel, logType)!;
            console.log(`Fletching ${logType} logs into ${product} (level ${fletchLevel})...`);

            // Fletch all logs with timeout protection
            let fletchedThisBatch = 0;
            let consecutiveFailures = 0;
            const fletchStart = Date.now();
            const maxFletchTime = 60_000; // 60 seconds max for fletching

            while (countLogs(ctx).total > 0 && Date.now() - fletchStart < maxFletchTime) {
                // Dismiss any dialogs first
                if (ctx.sdk.getState()?.dialog.isOpen) {
                    await sdk.sendClickDialog(0);
                    await sleep(200);
                    continue;
                }

                const currentLogs = countLogs(ctx);
                const currentLevel = getFletchingLevel(ctx);
                const currentUseOak = currentLevel >= 20 && currentLogs.oak > 0;
                const currentLogType = currentUseOak ? 'oak' : 'normal';

                // Stop if we only have oaks but can't fletch them
                if (currentLogs.normal === 0 && !currentUseOak) break;

                const currentProduct = getBestProduct(currentLevel, currentLogType)!;
                const fletchResult = await bot.fletchLogs(currentProduct);
                if (fletchResult.success) {
                    fletchedThisBatch++;
                    tracker.productsFletched++;
                    consecutiveFailures = 0;

                    // Check if we leveled up
                    const newLevel = getFletchingLevel(ctx);
                    if (newLevel !== fletchLevel) {
                        console.log(`Fletching level up! Now level ${newLevel}`);
                    }
                } else {
                    consecutiveFailures++;
                    console.log(`Fletch failed (${consecutiveFailures}/3): ${fletchResult.message}`);
                    if (consecutiveFailures >= 3) {
                        console.log(`Too many fletch failures, moving on...`);
                        break;
                    }
                    // Wait a bit before retry
                    await sleep(500);
                }
                await sleep(100);
            }

            if (fletchedThisBatch > 0) {
                console.log(`Fletched ${fletchedThisBatch} items`);
            }

        } else {
            // === CHOPPING PHASE ===
            // Normal trees until level 20, then oaks
            const useOaks = fletchLevel >= 20;
            const tree = useOaks
                ? sdk.findNearbyLoc(/^oak$/i) ?? sdk.findNearbyLoc(/^tree$/i)
                : sdk.findNearbyLoc(/^tree$/i);

            if (!tree) {
                const targetArea = useOaks ? OAK_TREES_AREA : NORMAL_TREES_AREA;
                console.log(`No trees nearby, walking to ${useOaks ? 'oak' : 'normal'} trees...`);
                await bot.walkTo(targetArea.x, targetArea.z);
                await sleep(500);
                continue;
            }

            // Chop the tree
            const chopResult = await bot.chopTree(tree);
            if (chopResult.success) {
                tracker.logsChopped++;

                // Log progress occasionally
                if (tracker.logsChopped % 10 === 0) {
                    logStats(ctx, tracker, `CHOP #${tracker.logsChopped}`);
                }
            } else {
                // Tree might be gone, wait and retry
                await sleep(500);
            }
        }

        await sleep(100);
    }
}

// Main script
async function main() {
    // Create fresh account
    const username = `fg${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, {
        position: { x: 3224, z: 3205 },  // Near knife spawn SE of castle
        inventory: [
            { id: Items.BRONZE_AXE, count: 1 },
        ],
    });

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {

            console.log('=== Fletching GP Maximizer ===');
            console.log('Goal: Maximize GP from fletching and selling longbows in 10 minutes');

            // Wait for state to initialize
            await new Promise(r => setTimeout(r, 2000));

            const state = ctx.sdk.getState();
            if (!state?.player) {
                console.error('No player state');
                return;
            }

            console.log(`Starting at (${state.player.worldX}, ${state.player.worldZ})`);

            // Dismiss any startup dialogs
            await ctx.bot.dismissBlockingUI();

            // Run the fletching loop
            await fletchingGP(ctx);

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
