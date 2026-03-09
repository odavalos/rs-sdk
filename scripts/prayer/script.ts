/**
 * Prayer Trainer Script
 *
 * Goal: Train Prayer from level 1 to level 10+
 *
 * Strategy:
 * - Walk to chicken coop near Lumbridge (east of castle)
 * - Kill chickens (they drop bones)
 * - Pick up bones and bury them
 * - Repeat until Prayer level 10
 *
 * Prayer XP per bone buried: 4.5 XP
 * XP needed for level 10: 1,154 XP
 * Bones needed: ~257 bones (1154 / 4.5)
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyNpc } from '../../sdk/types';

// Chicken coop is east of Lumbridge castle, near the farm
// The coop is fenced - need to enter through the gate
const CHICKEN_COOP_ENTRANCE = { x: 3237, z: 3295 };  // Just outside gate
const CHICKEN_COOP_INSIDE = { x: 3232, z: 3295 };    // Inside the coop

// Prayer level goal
const TARGET_PRAYER_LEVEL = 5;

// Stats tracking
interface PrayerStats {
    bonesCollected: number;
    bonesBuried: number;
    chickensKilled: number;
    startXp: number;
    startTime: number;
}

/**
 * Find the best chicken to attack.
 * Prioritizes chickens not in combat and closest to player.
 */
function findBestChicken(ctx: ScriptContext): NearbyNpc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    const chickens = state.nearbyNpcs
        .filter(npc => /^chicken$/i.test(npc.name))
        .filter(npc => npc.options.some(o => /attack/i.test(o)))
        // Filter out chickens already in combat
        .filter(npc => !npc.inCombat || npc.targetIndex === -1)
        .sort((a, b) => {
            // Prefer chickens not in combat
            if (a.inCombat !== b.inCombat) {
                return a.inCombat ? 1 : -1;
            }
            // Then by distance
            return a.distance - b.distance;
        });

    return chickens[0] ?? null;
}

/**
 * Wait for combat to end (chicken dies).
 * Chickens are level 1 and die very quickly.
 */
async function waitForCombatEnd(
    ctx: ScriptContext,
    targetNpc: NearbyNpc,
    stats: PrayerStats
): Promise<'kill' | 'fled' | 'lost_target'> {
    const maxWaitMs = 15000; // 15 seconds max for a chicken
    const startTime = Date.now();

    // Initial delay for combat to start
    await new Promise(r => setTimeout(r, 600));

    while (Date.now() - startTime < maxWaitMs) {
        await new Promise(r => setTimeout(r, 300));
        const state = ctx.sdk.getState();
        if (!state) return 'lost_target';

        // Dismiss any level-up dialogs
        if (state.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            continue;
        }

        // Find the chicken we're fighting
        const target = state.nearbyNpcs.find(n => n.index === targetNpc.index);

        if (!target) {
            // Chicken disappeared - it died
            stats.chickensKilled++;
            return 'kill';
        }

        // Check if chicken has 0 HP (dead)
        if (target.maxHp > 0 && target.hp === 0) {
            stats.chickensKilled++;
            return 'kill';
        }

    }

    return 'lost_target';
}

/**
 * Dismiss any open dialog (level-up, etc.)
 */
async function dismissDialog(ctx: ScriptContext): Promise<boolean> {
    const state = ctx.sdk.getState();
    if (state?.dialog.isOpen) {
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 300));
        return true;
    }
    return false;
}

/**
 * Bury all bones in inventory.
 */
async function buryAllBones(ctx: ScriptContext, stats: PrayerStats): Promise<void> {
    // Dismiss any dialogs before starting
    for (let i = 0; i < 5; i++) {
        if (!(await dismissDialog(ctx))) break;
    }

    // Re-fetch inventory after dismissing dialogs (state may have changed)
    let inventory = ctx.sdk.getInventory();
    let bones = inventory.filter(i => /^bones$/i.test(i.name));

    for (const bone of bones) {
        const state = ctx.sdk.getState();
        if (!state) break;

        // Dismiss any dialogs that appeared (level-up, etc.)
        if (state.dialog.isOpen) {
            await ctx.sdk.sendClickDialog(0);
            await new Promise(r => setTimeout(r, 300));
            continue;  // Re-check state after dismissing
        }

        // Re-check bone still exists (may have been buried in dialog handling)
        const currentInv = ctx.sdk.getInventory();
        const currentBone = currentInv.find(i => i.slot === bone.slot && /^bones$/i.test(i.name));
        if (!currentBone) continue;

        // Find "Bury" option on bone
        const buryOpt = currentBone.optionsWithIndex.find(o => /bury/i.test(o.text));
        if (buryOpt) {
            await ctx.sdk.sendUseItem(currentBone.slot, buryOpt.opIndex);
            stats.bonesBuried++;

            // Wait for bury animation and XP to register
            await new Promise(r => setTimeout(r, 700));

            // Log progress periodically
            if (stats.bonesBuried % 10 === 0) {
                const prayerSkill = ctx.sdk.getState()?.skills.find(s => s.name === 'Prayer');
                console.log(`Buried ${stats.bonesBuried} bones - Prayer: Level ${prayerSkill?.baseLevel} (${prayerSkill?.experience} XP)`);
            }
        }
    }
}

/**
 * Main prayer training loop
 */
async function prayerTrainingLoop(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state) throw new Error('No initial state');

    const prayerSkill = state.skills.find(s => s.name === 'Prayer');
    const stats: PrayerStats = {
        bonesCollected: 0,
        bonesBuried: 0,
        chickensKilled: 0,
        startXp: prayerSkill?.experience ?? 0,
        startTime: Date.now(),
    };

    console.log('=== Prayer Trainer ===');
    console.log(`Goal: Train Prayer to level ${TARGET_PRAYER_LEVEL}`);
    console.log(`Starting Prayer: Level ${prayerSkill?.baseLevel ?? 1} (${prayerSkill?.experience ?? 0} XP)`);
    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);

    // Dismiss any initial dialogs
    await ctx.bot.dismissBlockingUI();

    // Equip starting gear for faster kills
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

    // Walk to chicken coop entrance and enter through gate
    console.log(`Walking to chicken coop entrance at (${CHICKEN_COOP_ENTRANCE.x}, ${CHICKEN_COOP_ENTRANCE.z})...`);
    await ctx.bot.walkTo(CHICKEN_COOP_ENTRANCE.x, CHICKEN_COOP_ENTRANCE.z);
    await ctx.bot.walkTo(CHICKEN_COOP_ENTRANCE.x, CHICKEN_COOP_ENTRANCE.z);
    await ctx.bot.walkTo(CHICKEN_COOP_ENTRANCE.x, CHICKEN_COOP_ENTRANCE.z);

    // Open the gate to enter the chicken coop
    console.log('Opening chicken coop gate...');
    const gateResult = await ctx.bot.openDoor(/gate/i);
    if (!gateResult.success && gateResult.reason !== 'already_open') {
        console.warn(`Gate issue: ${gateResult.message}`);
    }

    // Walk inside the coop
    console.log(`Walking inside coop to (${CHICKEN_COOP_INSIDE.x}, ${CHICKEN_COOP_INSIDE.z})...`);
    await ctx.bot.walkTo(CHICKEN_COOP_INSIDE.x, CHICKEN_COOP_INSIDE.z);

    // Main loop
    while (true) {
        const currentState = ctx.sdk.getState();
        if (!currentState) {
            console.warn('Lost game state');
            break;
        }

        // Check if we've reached target level
        const prayer = currentState.skills.find(s => s.name === 'Prayer');
        if (prayer && prayer.baseLevel >= TARGET_PRAYER_LEVEL) {
            console.log(`*** Goal achieved! Prayer level ${prayer.baseLevel} ***`);
            break;
        }

        // Dismiss any dialogs (level-up, etc.) - click multiple times to clear multi-page dialogs
        if (currentState.dialog.isOpen) {
            for (let i = 0; i < 3; i++) {
                const s = ctx.sdk.getState();
                if (!s?.dialog.isOpen) break;
                await ctx.sdk.sendClickDialog(0);
                await new Promise(r => setTimeout(r, 300));
                }
            continue;
        }

        // Check inventory for bones - bury them as soon as we have any
        const inventory = ctx.sdk.getInventory();
        const bonesInInv = inventory.filter(i => /^bones$/i.test(i.name));

        // Bury bones immediately when we have 1+ (don't wait to accumulate)
        // This is faster than waiting and prevents inventory from filling
        if (bonesInInv.length >= 1) {
            if (bonesInInv.length > 1) {
                console.log(`Burying ${bonesInInv.length} bones...`);
            }
            await buryAllBones(ctx, stats);
            continue;
        }

        // Pick up nearby bones (prioritize closest)
        const groundBones = ctx.sdk.getGroundItems()
            .filter(i => /^bones$/i.test(i.name))
            .filter(i => i.distance <= 5)
            .sort((a, b) => a.distance - b.distance);

        if (groundBones.length > 0) {
            const bone = groundBones[0]!;
            const result = await ctx.bot.pickupItem(bone);
            if (result.success) {
                stats.bonesCollected++;
            }
            continue;
        }

        // Find a chicken to attack
        const chicken = findBestChicken(ctx);
        if (!chicken) {
            console.log('No chickens nearby - walking back inside coop...');
            await ctx.bot.walkTo(CHICKEN_COOP_INSIDE.x, CHICKEN_COOP_INSIDE.z);
            continue;
        }

        // Attack the chicken
        const attackResult = await ctx.bot.attackNpc(chicken);
        if (!attackResult.success) {
            console.warn(`Attack failed: ${attackResult.message}`);
            // Try opening gate if blocked
            if (attackResult.reason === 'out_of_reach') {
                await ctx.bot.openDoor(/gate/i);
            }
            continue;
        }

        // Wait for chicken to die
        await waitForCombatEnd(ctx, chicken, stats);
    }
}

async function main() {
    const username = `pr${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            try {
                await prayerTrainingLoop(ctx);
            } finally {
                // Log final stats
                const state = ctx.sdk.getState();
                if (state) {
                    const prayer = state.skills.find(s => s.name === 'Prayer');
                    console.log('=== Final Results ===');
                    console.log(`Prayer: Level ${prayer?.baseLevel ?? '?'} (${prayer?.experience ?? '?'} XP)`);
                    console.log(`Position: (${state.player?.worldX}, ${state.player?.worldZ})`);
                }
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 3 * 60 * 1000,  // 3 minutes for testing
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
