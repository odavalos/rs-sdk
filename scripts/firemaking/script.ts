/**
 * Firemaking Training Script
 *
 * Goal: Train Firemaking from level 1 to level 10+ starting from Lumbridge.
 *
 * Strategy:
 * 1. Start at Lumbridge (preset has tinderbox)
 * 2. Chop trees to get logs
 * 3. Burn logs using tinderbox
 * 4. Repeat until level 10
 *
 * Notes:
 * - LUMBRIDGE_SPAWN preset includes a tinderbox
 * - Trees respawn quickly in Lumbridge
 * - Fire lighting can fail if standing on a fire or blocked tile
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';
import type { NearbyLoc, InventoryItem } from '../../sdk/types';

// Lumbridge tree locations (near castle)
const LUMBRIDGE_TREES_AREA = { x: 3200, z: 3230 };

interface Stats {
    logsCut: number;
    logsBurned: number;
    startFiremakingXp: number;
    startWoodcuttingXp: number;
    startTime: number;
    lastProgressTime: number;
}

// ============ Helper Functions ============

// Note: ctx.progress() removed - bot actions and movement auto-reset stall timer

function getFiremakingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Firemaking')?.experience ?? 0;
}

function getFiremakingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Firemaking')?.baseLevel ?? 1;
}

function getWoodcuttingXp(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.experience ?? 0;
}

function getWoodcuttingLevel(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.skills.find(s => s.name === 'Woodcutting')?.baseLevel ?? 1;
}

function getPlayerPos(ctx: ScriptContext): { x: number; z: number } | null {
    const state = ctx.sdk.getState();
    if (!state?.player) return null;
    return { x: state.player.worldX, z: state.player.worldZ };
}

function countLogs(ctx: ScriptContext): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;
    return state.inventory.filter(item => /^logs$/i.test(item.name)).reduce((sum, i) => sum + i.count, 0);
}

function hasTinderbox(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state) return false;
    return state.inventory.some(item => /tinderbox/i.test(item.name));
}

function hasAxe(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state) return false;
    // Check inventory and equipment for any axe
    const inInv = state.inventory.some(item => /axe/i.test(item.name));
    const equipped = state.equipment.some(item => item && /axe/i.test(item.name));
    return inInv || equipped;
}

function findTree(ctx: ScriptContext): NearbyLoc | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    // Find regular trees (not oak, willow, etc. - those require higher levels)
    const trees = state.nearbyLocs
        .filter(loc => /^tree$/i.test(loc.name))
        .filter(loc => loc.options.some(opt => /^chop/i.test(opt)))
        .sort((a, b) => a.distance - b.distance);

    return trees[0] ?? null;
}

function getInventoryCount(ctx: ScriptContext): number {
    return ctx.sdk.getState()?.inventory.length ?? 0;
}

/**
 * Dismiss dialogs (level-up dialogs, etc.)
 */
async function dismissDialogs(ctx: ScriptContext, stats: Stats, maxCount: number = 3): Promise<number> {
    let dismissed = 0;
    while (ctx.sdk.getState()?.dialog.isOpen && dismissed < maxCount) {
        await ctx.sdk.sendClickDialog(0);
        await new Promise(r => setTimeout(r, 200));
        dismissed++;
        // progress auto-tracked
    }
    return dismissed;
}

// ============ Main Phases ============

/**
 * Phase 1: Chop trees until we have some logs
 */
async function chopTrees(ctx: ScriptContext, stats: Stats, targetLogs: number = 5): Promise<void> {
    console.log(`Chopping trees until we have ${targetLogs} logs...`);
    let attempts = 0;
    let noTreeCount = 0;

    while (countLogs(ctx) < targetLogs && getInventoryCount(ctx) < 28) {
        attempts++;
        if (attempts % 10 === 0) // progress auto-tracked

        // Dismiss any dialogs (level-up, etc.)
        if (await dismissDialogs(ctx, stats) > 0) continue;

        // Find a tree
        const tree = findTree(ctx);
        if (!tree) {
            noTreeCount++;
            if (noTreeCount % 20 === 0) {
                console.log('Waiting for tree to respawn...');
                // Walk around a bit to find more trees
                const pos = getPlayerPos(ctx);
                if (pos) {
                    const offsetX = (Math.random() - 0.5) * 10;
                    const offsetZ = (Math.random() - 0.5) * 10;
                    await ctx.sdk.sendWalk(pos.x + offsetX, pos.z + offsetZ, true);
                }
            }
            await new Promise(r => setTimeout(r, 200));
            continue;
        }

        noTreeCount = 0;

        // Chop the tree
        const logsBefore = countLogs(ctx);
        const result = await ctx.bot.chopTree(tree);
        // progress auto-tracked

        if (result.success) {
            const logsAfter = countLogs(ctx);
            if (logsAfter > logsBefore) {
                stats.logsCut += logsAfter - logsBefore;
                console.log(`Got logs! Total: ${stats.logsCut} (inventory: ${logsAfter})`);
            }
        }

        await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Finished chopping: ${countLogs(ctx)} logs in inventory`);
}

/**
 * Phase 2: Burn all logs
 */
async function burnLogs(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log('Burning logs...');

    while (countLogs(ctx) > 0) {
        // Dismiss any dialogs
        if (await dismissDialogs(ctx, stats) > 0) continue;

        const logsBefore = countLogs(ctx);
        const fmXpBefore = getFiremakingXp(ctx);

        const result = await ctx.bot.burnLogs();
        // progress auto-tracked

        if (result.success) {
            stats.logsBurned++;
            console.log(`Burned log! FM XP: +${result.xpGained}, Level: ${getFiremakingLevel(ctx)}`);
        } else {
            console.warn(`Failed to burn log: ${result.message}`);
            // If we failed, try moving to a different spot
            const pos = getPlayerPos(ctx);
            if (pos && result.message.includes('location')) {
                console.log('Moving to find a better spot...');
                const offsetX = (Math.random() - 0.5) * 6;
                const offsetZ = (Math.random() - 0.5) * 6;
                await ctx.sdk.sendWalk(pos.x + offsetX, pos.z + offsetZ, true);
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // Check if we're already at target level
        if (getFiremakingLevel(ctx) >= 10) {
            console.log('Reached level 10!');
            return;
        }

        await new Promise(r => setTimeout(r, 200));
    }
}

/**
 * Log final statistics
 */
function logFinalStats(ctx: ScriptContext, stats: Stats) {
    const state = ctx.sdk.getState();
    const firemaking = state?.skills.find(s => s.name === 'Firemaking');
    const woodcutting = state?.skills.find(s => s.name === 'Woodcutting');

    const fmXpGained = (firemaking?.experience ?? 0) - stats.startFiremakingXp;
    const wcXpGained = (woodcutting?.experience ?? 0) - stats.startWoodcuttingXp;
    const duration = (Date.now() - stats.startTime) / 1000;

    console.log('');
    console.log('=== Final Results ===');
    console.log(`Duration: ${Math.round(duration)}s`);
    console.log(`--- Woodcutting ---`);
    console.log(`  Level: ${woodcutting?.baseLevel ?? '?'}`);
    console.log(`  XP Gained: ${wcXpGained}`);
    console.log(`  Logs Cut: ${stats.logsCut}`);
    console.log(`--- Firemaking ---`);
    console.log(`  Level: ${firemaking?.baseLevel ?? '?'}`);
    console.log(`  XP Gained: ${fmXpGained}`);
    console.log(`  Logs Burned: ${stats.logsBurned}`);
}

/**
 * Main loop: chop → burn → repeat until level 10
 */
async function mainLoop(ctx: ScriptContext, stats: Stats): Promise<void> {
    console.log('=== Firemaking Training Script ===');
    console.log(`Starting levels: Firemaking ${getFiremakingLevel(ctx)}, Woodcutting ${getWoodcuttingLevel(ctx)}`);
    console.log(`Position: (${ctx.sdk.getState()?.player?.worldX}, ${ctx.sdk.getState()?.player?.worldZ})`);

    // Verify we have the required items
    if (!hasTinderbox(ctx)) {
        throw new Error('No tinderbox in inventory!');
    }
    if (!hasAxe(ctx)) {
        throw new Error('No axe in inventory or equipped!');
    }
    console.log('Tinderbox and axe confirmed.');

    await ctx.bot.dismissBlockingUI();
    // progress auto-tracked

    let cycle = 0;
    while (getFiremakingLevel(ctx) < 10) {
        cycle++;
        console.log(`\n--- Cycle ${cycle} ---`);
        console.log(`Current FM Level: ${getFiremakingLevel(ctx)}`);

        // Phase 1: Chop trees to get logs
        await chopTrees(ctx, stats, 5);

        // Phase 2: Burn all logs
        await burnLogs(ctx, stats);

        // progress auto-tracked
    }

    console.log('\n*** GOAL ACHIEVED: Firemaking Level 10+ ***');
}

// Main entry point
async function main() {
    // Create fresh account
    const username = `FM${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            const stats: Stats = {
                logsCut: 0,
                logsBurned: 0,
                startFiremakingXp: getFiremakingXp(ctx),
                startWoodcuttingXp: getWoodcuttingXp(ctx),
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
