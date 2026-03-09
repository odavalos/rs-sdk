/**
 * Combat Trainer Script
 *
 * Goal: Maximize Attack + Strength + Defence + Hitpoints levels over 10 minutes.
 *
 * Strategy:
 * - Phase 1: Kill cows at Lumbridge cow field, collect hides (~50 needed)
 * - Phase 2: Sell hides at Lumbridge general store for ~130gp
 * - Phase 3: Pass through Al Kharid gate (10gp toll), buy iron scimitar (112gp)
 * - Phase 4: Return to cow field and train with iron scimitar
 * - Cycle combat styles for balanced Attack/Strength/Defence training
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc } from '../../sdk/types';

// Combat style indices for swords (4 styles: Stab, Lunge, Slash, Block)
// See: https://oldschool.runescape.wiki/w/Combat_Options
const COMBAT_STYLES = {
    ACCURATE: 0,    // Stab - Trains Attack
    AGGRESSIVE: 1,  // Lunge - Trains Strength
    CONTROLLED: 2,  // Slash - Trains Attack+Strength+Defence evenly
    DEFENSIVE: 3,   // Block - Trains Defence only
};

// Training locations
const LOCATIONS = {
    COW_FIELD: { x: 3253, z: 3269 },           // Lumbridge cow field (east of castle)
    LUMBRIDGE_GENERAL_STORE: { x: 3211, z: 3247 },  // To sell hides
    ALKHARID_GATE: { x: 3268, z: 3228 },       // Gate to Al Kharid
    ALKHARID_SCIMITAR_SHOP: { x: 3287, z: 3186 },  // Zeke's shop
};

// Upgrade config
const IRON_SCIMITAR_PRICE = 112;
const GATE_TOLL = 10;
const COINS_NEEDED = IRON_SCIMITAR_PRICE + GATE_TOLL + 10;  // 132gp buffer
const HIDES_NEEDED = 50;  // ~2-3gp each = 100-150gp

/**
 * Count total cowhides in inventory (they don't stack, so count items)
 */
function countCowhides(ctx: ScriptContext): number {
    const inventory = ctx.sdk.getInventory();
    return inventory.filter(i => /^cow\s?hide$/i.test(i.name)).reduce((sum, i) => sum + (i.count ?? 1), 0);
}

/**
 * Count total coins in inventory
 */
function countCoins(ctx: ScriptContext): number {
    const coins = ctx.sdk.findInventoryItem(/^coins$/i);
    return coins?.count ?? 0;
}

/**
 * Get free inventory slots
 */
function getFreeSlots(ctx: ScriptContext): number {
    const inventory = ctx.sdk.getInventory();
    return 28 - inventory.length;
}

/**
 * Drop bones to make room for hides (bones are worth less than hides)
 */
async function dropBonesIfNeeded(ctx: ScriptContext): Promise<void> {
    const freeSlots = getFreeSlots(ctx);

    // If inventory has 2 or fewer free slots, drop bones to make room
    if (freeSlots <= 2) {
        const inventory = ctx.sdk.getInventory();
        const bones = inventory.filter(i => /^bones$/i.test(i.name));

        if (bones.length > 0) {
            console.log(`Dropping ${bones.length} bones to make room for hides...`);
            for (const bone of bones.slice(0, 5)) {  // Drop up to 5 bones at a time
                await ctx.sdk.sendDropItem(bone.slot);
                await new Promise(r => setTimeout(r, 300));
            }
        }
    }
}

// Track combat statistics
interface CombatStats {
    kills: number;
    damageDealt: number;
    damageTaken: number;
    startXp: { atk: number; str: number; def: number; hp: number };
    foodEaten: number;
    looted: number;
    hidesCollected: number;
    coinsCollected: number;
    weaponUpgraded: boolean;
    phase: 'farming' | 'selling' | 'buying' | 'training';  // Cow-based phases
    lastStatsLog: number;
    startTime: number;           // For timing
    lastTimeBasedLog: number;    // Last time-based log timestamp
}

/**
 * Find the best cow to attack.
 * Cows are level 2, easy targets that drop valuable hides.
 */
function findBestTarget(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    const targets = state.nearbyNpcs
        .filter(npc => /^cow$/i.test(npc.name))  // Only cows (not "cow calf")
        .filter(npc => npc.options.some(o => /attack/i.test(o)))
        // Filter out NPCs we know are busy (recently returned "already in combat")
        .filter(npc => canAttackNpc(npc.index))
        // Filter out NPCs already fighting someone else
        .filter(npc => {
            if (npc.targetIndex === -1) return true;
            return !npc.inCombat;
        })
        .sort((a, b) => {
            // Prefer NPCs not in combat
            if (a.inCombat !== b.inCombat) {
                return a.inCombat ? 1 : -1;
            }
            // Then by distance
            return a.distance - b.distance;
        });

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

    // Eat if below 50% HP
    return hp.level < hp.baseLevel * 0.5;
}

// Style rotation for 2:3:2 ratio (Attack:Strength:Defence)
// Strength-focused training for faster kills
const STYLE_ROTATION = [
    { style: COMBAT_STYLES.ACCURATE, name: 'Stab (Attack)' },
    { style: COMBAT_STYLES.ACCURATE, name: 'Stab (Attack)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Lunge (Strength)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Lunge (Strength)' },
    { style: COMBAT_STYLES.AGGRESSIVE, name: 'Lunge (Strength)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Block (Defence)' },
    { style: COMBAT_STYLES.DEFENSIVE, name: 'Block (Defence)' },
];

// Track style cycling - initialized in resetStyleCycling()
let lastStyleChange = 0;
let currentStyleIndex = 0;
const STYLE_CYCLE_MS = 20_000;  // Change every 20 seconds (full rotation = 140s)

// Track which style we last SET (not what the game reports)
let lastSetStyle = -1;

// Track failed pickups to avoid retrying (key: "x,z,id", value: timestamp)
const failedPickups = new Map<string, number>();
const FAILED_PICKUP_COOLDOWN = 30_000;  // Don't retry failed pickups for 30 seconds

function canAttemptPickup(item: { x: number; z: number; id: number }): boolean {
    const key = `${item.x},${item.z},${item.id}`;
    const lastFailed = failedPickups.get(key);
    if (lastFailed && Date.now() - lastFailed < FAILED_PICKUP_COOLDOWN) {
        return false;  // Still on cooldown
    }
    return true;
}

function markPickupFailed(item: { x: number; z: number; id: number }): void {
    const key = `${item.x},${item.z},${item.id}`;
    failedPickups.set(key, Date.now());
    // Clean up old entries
    const now = Date.now();
    for (const [k, v] of failedPickups.entries()) {
        if (now - v > FAILED_PICKUP_COOLDOWN * 2) {
            failedPickups.delete(k);
        }
    }
}

// Track NPCs that are "already in combat" to avoid attacking them repeatedly
const busyNpcs = new Map<number, number>();  // NPC index -> timestamp
const BUSY_NPC_COOLDOWN = 15_000;  // Don't retry NPCs that were busy for 15 seconds

function canAttackNpc(npcIndex: number): boolean {
    const lastBusy = busyNpcs.get(npcIndex);
    if (lastBusy && Date.now() - lastBusy < BUSY_NPC_COOLDOWN) {
        return false;
    }
    return true;
}

function markNpcBusy(npcIndex: number): void {
    busyNpcs.set(npcIndex, Date.now());
    // Clean up old entries
    const now = Date.now();
    for (const [k, v] of busyNpcs.entries()) {
        if (now - v > BUSY_NPC_COOLDOWN * 2) {
            busyNpcs.delete(k);
        }
    }
}

/**
 * Reset style cycling state - call at start of training
 */
function resetStyleCycling(): void {
    lastStyleChange = Date.now();
    currentStyleIndex = 0;
    lastSetStyle = -1;
}

/**
 * Cycle combat style for 2:3:2 Attack:Strength:Defence ratio.
 * Time-based cycling since kill counting is unreliable.
 * IMPORTANT: Always set the style, don't rely on game state reporting correctly.
 */
async function cycleCombatStyle(ctx: ScriptContext): Promise<void> {
    // Check if it's time to switch styles
    const now = Date.now();
    if (now - lastStyleChange >= STYLE_CYCLE_MS) {
        currentStyleIndex = (currentStyleIndex + 1) % STYLE_ROTATION.length;
        lastStyleChange = now;
    }

    const target = STYLE_ROTATION[currentStyleIndex]!;

    // Always set style if it differs from what we last set (don't trust game state)
    if (lastSetStyle !== target.style) {
        console.log(`Setting ${target.name} style (slot ${currentStyleIndex}/7)`);
        await ctx.sdk.sendSetCombatStyle(target.style);
        lastSetStyle = target.style;
    }
}

/**
 * Wait for current combat to complete (NPC dies or we need to heal)
 * Uses multiple detection methods: XP gains, combatCycle, and NPC disappearance.
 */
async function waitForCombatEnd(
    ctx: ScriptContext,
    targetNpc: NearbyNpc,
    stats: CombatStats
): Promise<'kill' | 'fled' | 'lost_target' | 'need_heal'> {
    let lastSeenTick = ctx.sdk.getState()?.tick ?? 0;
    let combatStarted = false;
    let ticksSinceCombatEnded = 0;
    let loopCount = 0;

    // Track starting XP to detect combat via XP gains
    const startState = ctx.sdk.getState();
    const startXp = {
        def: startState?.skills.find(s => s.name === 'Defence')?.experience ?? 0,
        hp: startState?.skills.find(s => s.name === 'Hitpoints')?.experience ?? 0,
    };

    // Wait up to 30 seconds for combat to resolve
    const maxWaitMs = 30000;
    const startTime = Date.now();

    // Initial delay to let combat actually start (attack animation takes time)
    await new Promise(r => setTimeout(r, 800));

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, 400));
        loopCount++;
        const state = ctx.sdk.getState();
        if (!state) return 'lost_target';

        const currentTick = state.tick;

        // Check if we need to heal
        if (shouldEat(ctx)) {
            return 'need_heal';
        }

        // Check XP gains as combat indicator (most reliable!)
        const currentXp = {
            def: state.skills.find(s => s.name === 'Defence')?.experience ?? 0,
            hp: state.skills.find(s => s.name === 'Hitpoints')?.experience ?? 0,
        };
        const xpGained = (currentXp.def - startXp.def) + (currentXp.hp - startXp.hp);
        if (xpGained > 0) {
            combatStarted = true;  // XP gain = definitely in combat
        }

        // Find our target NPC
        const target = state.nearbyNpcs.find(n => n.index === targetNpc.index);

        if (!target) {
            // NPC disappeared - count as kill if we gained XP or waited a bit
            if (combatStarted || xpGained > 0 || loopCount >= 2) {
                stats.kills++;
                return 'kill';
            }
            return 'lost_target';
        }

        // Check NPC health - if 0, it died (only valid once maxHp > 0)
        if (target.maxHp > 0 && target.hp === 0) {
            stats.kills++;
            return 'kill';
        }

        // Track combat events
        for (const event of state.combatEvents) {
            if (event.tick > lastSeenTick) {
                if (event.type === 'damage_dealt' && event.targetIndex === targetNpc.index) {
                    stats.damageDealt += event.damage;
                    combatStarted = true;
                }
                if (event.type === 'damage_taken') {
                    stats.damageTaken += event.damage;
                    combatStarted = true;
                }
            }
        }
        lastSeenTick = currentTick;

        // Check combat status via combatCycle
        const npcInCombat = target.combatCycle > currentTick;
        const playerInCombat = state.player?.combat?.inCombat ?? false;
        const inActiveCombat = playerInCombat || npcInCombat || xpGained > 0;

        if (inActiveCombat) {
            combatStarted = true;
            ticksSinceCombatEnded = 0;
        } else if (combatStarted) {
            ticksSinceCombatEnded++;
            if (ticksSinceCombatEnded >= 4) {
                return 'fled';
            }
        } else if (loopCount >= 8) {
            // Combat never started after ~4 seconds
            return 'lost_target';
        }

    }

    return 'lost_target';
}

/**
 * Sell cow hides at Lumbridge general store.
 */
async function sellHides(ctx: ScriptContext, stats: CombatStats): Promise<boolean> {
    console.log('=== Selling Cow Hides ===');
    stats.phase = 'selling';

    const hideCount = countCowhides(ctx);
    if (hideCount === 0) {
        console.warn('No cow hides to sell!');
        stats.phase = 'farming';
        return false;
    }

    console.log(`Walking to Lumbridge general store with ${hideCount} hides...`);
    await ctx.bot.walkTo(LOCATIONS.LUMBRIDGE_GENERAL_STORE.x, LOCATIONS.LUMBRIDGE_GENERAL_STORE.z);

    const shopResult = await ctx.bot.openShop(/shop.?keeper/i);
    if (!shopResult.success) {
        console.warn('Failed to open general store');
        stats.phase = 'farming';
        return false;
    }

    // Sell all hides (one at a time since they don't stack)
    const inventory = ctx.sdk.getInventory();
    const allHides = inventory.filter(i => /^cow\s?hide$/i.test(i.name));
    let soldCount = 0;

    for (const hide of allHides) {
        const sellResult = await ctx.bot.sellToShop(/^cow\s?hide$/i, 1);
        if (sellResult.success) {
            soldCount++;
        } else {
            console.warn(`Failed to sell hide: ${sellResult.message}`);
            break;
        }
    }

    console.log(`Sold ${soldCount} cow hides!`);
    await ctx.bot.closeShop();

    // Check coins
    const coins = ctx.sdk.findInventoryItem(/^coins$/i);
    const coinCount = coins?.count ?? 0;
    console.log(`Total coins: ${coinCount}`);

    return true;
}

/**
 * Buy iron scimitar from Al Kharid.
 * 1. Pass through toll gate (10gp)
 * 2. Buy iron scimitar from Zeke (112gp)
 * 3. Return to cow field
 */
async function buyIronScimitar(ctx: ScriptContext, stats: CombatStats): Promise<boolean> {
    console.log('=== Buying Iron Scimitar ===');
    stats.phase = 'buying';

    // Check we have enough coins
    let coins = ctx.sdk.findInventoryItem(/^coins$/i);
    let coinCount = coins?.count ?? 0;

    if (coinCount < COINS_NEEDED) {
        console.warn(`Not enough coins (${coinCount}/${COINS_NEEDED})`);
        stats.phase = 'farming';
        return false;
    }

    // Walk to Al Kharid gate
    console.log('Walking to Al Kharid gate...');
    await ctx.bot.walkTo(LOCATIONS.ALKHARID_GATE.x, LOCATIONS.ALKHARID_GATE.z);

    // Handle toll gate
    console.log('Opening toll gate...');
    const gate = ctx.sdk.getState()?.nearbyLocs.find(l => /gate/i.test(l.name));
    if (gate) {
        const openOpt = gate.optionsWithIndex.find(o => /open/i.test(o.text));
        if (openOpt) {
            await ctx.sdk.sendInteractLoc(gate.x, gate.z, gate.id, openOpt.opIndex);
            await new Promise(r => setTimeout(r, 800));
        }
    }

    // Handle gate dialog
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
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
    }

    // Walk through gate
    await new Promise(r => setTimeout(r, 1000));
    for (let i = 0; i < 10; i++) {
        const state = ctx.sdk.getState();
        if ((state?.player?.worldX ?? 0) >= 3270) {
            console.log('Entered Al Kharid!');
            break;
        }
        if (state?.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 200));
            continue;
        }
        await ctx.bot.walkTo(3277, 3227);
        await new Promise(r => setTimeout(r, 800));
    }

    // Verify in Al Kharid
    if ((ctx.sdk.getState()?.player?.worldX ?? 0) < 3270) {
        console.warn('Failed to enter Al Kharid');
        stats.phase = 'farming';
        return false;
    }

    // Walk to Zeke's shop
    console.log('Walking to Zeke\'s Scimitar Shop...');
    await ctx.bot.walkTo(LOCATIONS.ALKHARID_SCIMITAR_SHOP.x, LOCATIONS.ALKHARID_SCIMITAR_SHOP.z);

    // Buy iron scimitar
    const scimitarShop = await ctx.bot.openShop(/zeke/i);
    if (!scimitarShop.success) {
        console.warn('Failed to open scimitar shop');
        stats.phase = 'training';
        return false;
    }

    const buyScim = await ctx.bot.buyFromShop(/iron scimitar/i, 1);
    if (buyScim.success) {
        console.log('*** IRON SCIMITAR PURCHASED! ***');
        stats.weaponUpgraded = true;
    } else {
        console.warn(`Failed to buy scimitar: ${buyScim.message}`);
    }
    await ctx.bot.closeShop();

    // Equip the scimitar
    const scimitar = ctx.sdk.findInventoryItem(/iron scimitar/i);
    if (scimitar) {
        console.log('Equipping iron scimitar...');
        await ctx.bot.equipItem(scimitar);
    }

    // Return to cow field
    console.log('Returning to cow field...');
    // Walk back through gate (no toll to exit)
    await ctx.bot.walkTo(3267, 3227);  // Outside gate
    await new Promise(r => setTimeout(r, 500));
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);

    stats.phase = 'training';
    console.log('=== Ready to train with Iron Scimitar! ===');
    return true;
}

/**
 * Main combat training loop - Cow Hide Strategy
 */
async function combatTrainingLoop(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) throw new Error('No initial state');

    // Initialize stats tracking
    const now = Date.now();
    const stats: CombatStats = {
        kills: 0,
        damageDealt: 0,
        damageTaken: 0,
        startXp: {
            atk: state.skills.find(s => s.name === 'Attack')?.experience ?? 0,
            str: state.skills.find(s => s.name === 'Strength')?.experience ?? 0,
            def: state.skills.find(s => s.name === 'Defence')?.experience ?? 0,
            hp: state.skills.find(s => s.name === 'Hitpoints')?.experience ?? 0,
        },
        foodEaten: 0,
        looted: 0,
        hidesCollected: 0,
        coinsCollected: 0,
        weaponUpgraded: false,
        phase: 'farming',  // Start farming cow hides
        lastStatsLog: 0,
        startTime: now,
        lastTimeBasedLog: now,
    };

    console.log('=== Combat Trainer - Cow Hide Strategy ===');
    console.log(`Goal: Collect ${HIDES_NEEDED} cow hides → Sell → Buy Iron Scimitar → Train`);
    console.log(`Starting XP - Atk: ${stats.startXp.atk}, Str: ${stats.startXp.str}, Def: ${stats.startXp.def}, HP: ${stats.startXp.hp}`);

    // Initialize style cycling timer now (not at module load)
    resetStyleCycling();

    // Equip starting gear
    const sword = ctx.sdk.findInventoryItem(/bronze sword/i);
    if (sword) {
        console.log(`Equipping ${sword.name}...`);
        await ctx.bot.equipItem(sword);
    }

    const shield = ctx.sdk.findInventoryItem(/wooden shield/i);
    if (shield) {
        console.log(`Equipping ${shield.name}...`);
        await ctx.bot.equipItem(shield);
    }

    // Walk to cow field
    console.log('Walking to cow field...');
    await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);

    // Main training loop
    while (true) {
        const currentState = ctx.sdk.getState();
        if (!currentState) {
            console.warn('Lost game state');
            break;
        }

        // Dismiss any blocking dialogs
        if (currentState.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            continue;
        }

        // Log periodic stats (every 10 kills or every 5 minutes)
        const timeSinceLastLog = Date.now() - stats.lastTimeBasedLog;
        const shouldLogByKills = stats.kills > 0 && stats.kills % 10 === 0 && stats.kills !== stats.lastStatsLog;
        const shouldLogByTime = timeSinceLastLog >= 5 * 60_000;  // 5 minutes

        if (shouldLogByKills || shouldLogByTime) {
            stats.lastStatsLog = stats.kills;
            stats.lastTimeBasedLog = Date.now();
            logStats(ctx, stats);
        }

        // Cycle combat style for balanced training (time-based)
        await cycleCombatStyle(ctx);

        // Check current resources using proper counting
        const hideCount = countCowhides(ctx);
        const coinCount = countCoins(ctx);

        // Phase logic: farming → selling → buying → training
        if (stats.phase === 'farming' && !stats.weaponUpgraded) {
            // Check if we have enough hides to sell
            if (hideCount >= HIDES_NEEDED) {
                console.log(`Collected ${hideCount} hides! Time to sell and buy scimitar!`);
                await sellHides(ctx, stats);
                continue;
            }

            // Also check if we already have enough coins (from previous attempts or loot)
            if (coinCount >= COINS_NEEDED) {
                console.log(`Already have ${coinCount} coins! Skipping to buy scimitar!`);
                await buyIronScimitar(ctx, stats);
                continue;
            }

            // Drop bones if inventory is getting full (prioritize hides over bones)
            await dropBonesIfNeeded(ctx);
        }

        if (stats.phase === 'selling') {
            // After selling, try to buy
            const newCoinCount = countCoins(ctx);
            if (newCoinCount >= COINS_NEEDED) {
                await buyIronScimitar(ctx, stats);
            } else {
                console.log(`Only ${newCoinCount} coins, need ${COINS_NEEDED}. Collecting more hides...`);
                stats.phase = 'farming';
            }
            continue;
        }

        // Pick up loot - prioritize cowhides!
        // Skip bones if: inventory tight, or in training phase (don't need money anymore)
        const skipBones = getFreeSlots(ctx) <= 4 || stats.phase === 'training';
        // In training phase, only pick up hides if we're still working toward iron scimitar
        const shouldLoot = stats.phase === 'farming' || !stats.weaponUpgraded;

        const loot = shouldLoot ? ctx.sdk.getGroundItems()
            .filter(i => /cow\s?hide|cowhide|bones|coins/i.test(i.name))
            .filter(i => !skipBones || !/^bones$/i.test(i.name))  // Skip bones if inventory tight
            .filter(i => i.distance <= 3)  // Reduced from 5 to avoid timeouts
            .filter(i => canAttemptPickup(i))  // Skip items we recently failed to pick up
            .sort((a, b) => {
                // Priority: hides > coins > bones
                const priority = (name: string) => {
                    if (/cow\s?hide|cowhide/i.test(name)) return 0;
                    if (/coins/i.test(name)) return 1;
                    return 2;
                };
                return priority(a.name) - priority(b.name) || a.distance - b.distance;
            }) : [];

        if (loot.length > 0) {
            const item = loot[0]!;
            const result = await ctx.bot.pickupItem(item);
            if (result.success) {
                stats.looted++;
                if (/cow\s?hide|cowhide/i.test(item.name)) {
                    stats.hidesCollected += item.count ?? 1;
                    const totalHides = countCowhides(ctx);
                    console.log(`Picked up cowhide (${totalHides}/${HIDES_NEEDED})`);
                } else if (/coins/i.test(item.name)) {
                    stats.coinsCollected += item.count ?? 1;
                }
            } else {
                // Mark this item as failed so we don't retry immediately
                markPickupFailed(item);
            }
        }

        // Find a cow to attack
        const target = findBestTarget(ctx);
        if (!target) {
            console.log('No cows nearby - walking to cow field...');
            await ctx.bot.walkTo(LOCATIONS.COW_FIELD.x, LOCATIONS.COW_FIELD.z);
            continue;
        }

        // Check if already fighting
        const playerCombat = currentState.player?.combat;
        if (playerCombat?.inCombat && playerCombat.targetIndex === target.index) {
            const result = await waitForCombatEnd(ctx, target, stats);
            continue;
        }

        // Attack the cow
        const attackResult = await ctx.bot.attackNpc(target);
        if (!attackResult.success) {
            console.warn(`Attack failed: ${attackResult.message}`);
            // Mark NPC as busy if already in combat (won't retry for 15s)
            if (attackResult.reason === 'already_in_combat') {
                markNpcBusy(target.index);
            }
            // Try opening gate if blocked
            if (attackResult.reason === 'out_of_reach') {
                await ctx.bot.openDoor(/gate/i);
            }
            continue;
        }

        // Wait for combat to complete
        const combatResult = await waitForCombatEnd(ctx, target, stats);
        if (combatResult === 'kill') {
            console.log(`Kill #${stats.kills}! (Hides: ${hideCount}/${HIDES_NEEDED})`);
        }
    }
}

/**
 * Log current training statistics
 */
function logStats(ctx: ScriptContext, stats: CombatStats): void {
    const state = ctx.sdk.getState();
    if (!state) return;

    const currentXp = {
        atk: state.skills.find(s => s.name === 'Attack')?.experience ?? 0,
        str: state.skills.find(s => s.name === 'Strength')?.experience ?? 0,
        def: state.skills.find(s => s.name === 'Defence')?.experience ?? 0,
        hp: state.skills.find(s => s.name === 'Hitpoints')?.experience ?? 0,
    };

    const xpGained = {
        atk: currentXp.atk - stats.startXp.atk,
        str: currentXp.str - stats.startXp.str,
        def: currentXp.def - stats.startXp.def,
        hp: currentXp.hp - stats.startXp.hp,
    };

    const totalXp = xpGained.atk + xpGained.str + xpGained.def + xpGained.hp;
    const hides = countCowhides(ctx);

    // Calculate XP/hour
    const elapsedMs = Date.now() - stats.startTime;
    const elapsedMinutes = Math.round(elapsedMs / 60_000);
    const xpPerHour = elapsedMs > 60_000 ? Math.round(totalXp / (elapsedMs / 3_600_000)) : 0;

    console.log(`--- Stats after ${elapsedMinutes}m / ${stats.kills} kills (Phase: ${stats.phase}) ---`);
    console.log(`XP: Atk +${xpGained.atk}, Str +${xpGained.str}, Def +${xpGained.def}, HP +${xpGained.hp} (Total: +${totalXp})`);
    console.log(`XP/hour: ~${xpPerHour.toLocaleString()}`);
    console.log(`Hides: ${hides}/${HIDES_NEEDED}, Coins: ${stats.coinsCollected}`);
    console.log(`Weapon: ${stats.weaponUpgraded ? 'IRON SCIMITAR!' : 'Bronze Sword'}`);
}

async function main() {
    // Create fresh account
    const username = `CT${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            try {
                await combatTrainingLoop(ctx);
            } finally {
                // Log final stats
                const state = ctx.sdk.getState();
                if (state) {
                    const skills = state.skills;
                    const atk = skills.find(s => s.name === 'Attack');
                    const str = skills.find(s => s.name === 'Strength');
                    const def = skills.find(s => s.name === 'Defence');
                    const hp = skills.find(s => s.name === 'Hitpoints');
                    const scimitar = ctx.sdk.findInventoryItem(/iron scimitar/i) ||
                                    state.equipment?.find(e => /iron scimitar/i.test(e.name));

                    console.log('=== Final Results ===');
                    console.log(`Combat Level: ${state.player?.combatLevel ?? '?'}`);
                    console.log(`Attack: Level ${atk?.baseLevel} (${atk?.experience} XP)`);
                    console.log(`Strength: Level ${str?.baseLevel} (${str?.experience} XP)`);
                    console.log(`Defence: Level ${def?.baseLevel} (${def?.experience} XP)`);
                    console.log(`Hitpoints: Level ${hp?.baseLevel} (${hp?.experience} XP)`);
                    console.log(`Iron Scimitar: ${scimitar ? 'YES!' : 'No'}`);
                    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);
                }
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 30 * 60 * 1000,
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
