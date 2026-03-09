/**
 * Agility Training Script
 *
 * Goal: Train Agility from level 1 to 10+ using the Gnome Stronghold Agility Course
 *
 * Uses GNOME_AGILITY preset to start directly at the course.
 *
 * Course obstacles (in order):
 * 1. Log balance (Walk-across) - 7.5 XP
 * 2. Obstacle net (Climb-over) - 7.5 XP
 * 3. Tree branch (Climb) - 5 XP
 * 4. Balancing rope (Walk-on) - 7.5 XP
 * 5. Tree branch (Climb-down) - 5 XP
 * 6. Obstacle net (Climb-over) - 7.5 XP
 * 7. Obstacle pipe (Squeeze-through) - 7.5 XP + 39 XP bonus for completing course
 *
 * Total per lap: ~86.5 XP
 * XP needed for level 10: 1,154 XP = ~14 laps
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Gnome Stronghold Agility Course start location
const GNOME_AGILITY_START = { x: 2474, z: 3436 };

// XP requirements
const TARGET_LEVEL = 10;
const XP_FOR_LEVEL_10 = 1154;

// Course obstacle definitions (in order around the course)
const COURSE_OBSTACLES = [
    { name: /log balance/i, option: /walk/i, description: 'Log balance' },
    { name: /obstacle net/i, option: /climb/i, description: 'First net' },
    { name: /tree branch/i, option: /^climb$/i, description: 'Tree branch up' },
    { name: /balancing rope/i, option: /walk/i, description: 'Balancing rope' },
    { name: /tree branch/i, option: /climb-down/i, description: 'Tree branch down' },
    { name: /obstacle net/i, option: /climb/i, description: 'Second net' },
    { name: /obstacle pipe/i, option: /squeeze/i, description: 'Obstacle pipe' },
];

/**
 * Calculate distance to a point
 */
function distanceTo(ctx: ScriptContext, x: number, z: number): number {
    const state = ctx.sdk.getState();
    if (!state?.player) return Infinity;
    const dx = x - state.player.worldX;
    const dz = z - state.player.worldZ;
    return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Find the next agility obstacle to interact with
 */
function findNextObstacle(ctx: ScriptContext, courseIndex: number) {
    const locs = ctx.sdk.getNearbyLocs();
    const target = COURSE_OBSTACLES[courseIndex % COURSE_OBSTACLES.length];

    if (!target) return null;

    // Find obstacle matching this course position
    const obstacle = locs.find(loc =>
        target.name.test(loc.name) &&
        loc.optionsWithIndex.some(o => target.option.test(o.text))
    );

    // Debug: if not found, log nearby agility-like obstacles
    if (!obstacle && courseIndex === 0) {
        const agilityLocs = locs.filter(loc =>
            loc.optionsWithIndex.some(o =>
                /walk|climb|squeeze|balance|cross/i.test(o.text)
            )
        );
        if (agilityLocs.length > 0) {
            console.log(`Nearby agility objects: ${agilityLocs.map(l => `${l.name}@(${l.x},${l.z})`).join(', ')}`);
        }
    }

    return obstacle;
}

/**
 * Complete one obstacle
 */
async function completeObstacle(ctx: ScriptContext, courseIndex: number): Promise<boolean> {
    const xpBefore = ctx.sdk.getSkill('Agility')?.experience ?? 0;
    const target = COURSE_OBSTACLES[courseIndex % COURSE_OBSTACLES.length];
    const startTick = ctx.sdk.getState()?.tick ?? 0;

    const obstacle = findNextObstacle(ctx, courseIndex);
    if (!obstacle) {
        console.warn(`Could not find obstacle: ${target?.description}`);
        return false;
    }

    const opt = obstacle.optionsWithIndex.find(o => target!.option.test(o.text));
    if (!opt) {
        console.warn(`No matching option on ${obstacle.name}`);
        return false;
    }

    console.log(`Attempting: ${obstacle.name} (${opt.text})`);

    // Walk closer if needed
    if (obstacle.distance > 3) {
        await ctx.bot.walkTo(obstacle.x, obstacle.z, 2);
    }

    // Interact with obstacle
    await ctx.sdk.sendInteractLoc(obstacle.x, obstacle.z, obstacle.id, opt.opIndex);

    // Wait for XP gain or significant position change
    const startX = ctx.sdk.getState()?.player?.worldX ?? 0;
    const startZ = ctx.sdk.getState()?.player?.worldZ ?? 0;

    try {
        await ctx.sdk.waitForCondition(state => {
            // Dismiss dialogs (level-up messages)
            if (state.dialog.isOpen) {
                ctx.sdk.sendClickDialog(0).catch(() => {});
                return false;
            }

            // XP gain
            const xpNow = state.skills.find(s => s.name === 'Agility')?.experience ?? 0;
            if (xpNow > xpBefore) return true;

            // Significant position change (obstacle completed)
            const dx = Math.abs((state.player?.worldX ?? 0) - startX);
            const dz = Math.abs((state.player?.worldZ ?? 0) - startZ);
            if (dx > 4 || dz > 4) return true;

            // Check for "can not do that from here" message
            for (const msg of state.gameMessages) {
                if (msg.tick > startTick && msg.text.toLowerCase().includes('can not do that')) {
                    return true;
                }
            }

            return false;
        }, 20000);

        const xpAfter = ctx.sdk.getSkill('Agility')?.experience ?? 0;
        if (xpAfter > xpBefore) {
            console.log(`  XP gained: +${xpAfter - xpBefore}`);
            return true;
        }

        // Position changed but no XP - might need to re-attempt
        const endX = ctx.sdk.getState()?.player?.worldX ?? 0;
        const endZ = ctx.sdk.getState()?.player?.worldZ ?? 0;
        if (Math.abs(endX - startX) > 4 || Math.abs(endZ - startZ) > 4) {
            console.log(`  Position changed - obstacle may be complete`);
            return true;
        }

        console.warn(`  Obstacle did not complete`);
        return false;

    } catch {
        console.warn(`  Timeout waiting for obstacle completion`);
        return false;
    }
}

/**
 * Complete one full lap of the course
 */
async function completeLap(ctx: ScriptContext): Promise<boolean> {
    console.log('Starting new lap...');

    for (let i = 0; i < COURSE_OBSTACLES.length; i++) {
        const success = await completeObstacle(ctx, i);
        if (!success) {
            // Try to find any nearby obstacle and continue
            const locs = ctx.sdk.getNearbyLocs();
            const anyObstacle = locs.find(loc =>
                loc.optionsWithIndex.some(o =>
                    /walk|climb|squeeze|balance/i.test(o.text)
                )
            );

            if (anyObstacle) {
                console.log(`Found alternate obstacle: ${anyObstacle.name}`);
                const opt = anyObstacle.optionsWithIndex.find(o =>
                    /walk|climb|squeeze|balance/i.test(o.text)
                );
                if (opt) {
                    await ctx.sdk.sendInteractLoc(anyObstacle.x, anyObstacle.z, anyObstacle.id, opt.opIndex);
                    try {
                        await ctx.sdk.waitForStateChange(5000);
                    } catch { /* ignore */ }
                }
            }
        }
    }

    return true;
}

/**
 * Main training function
 */
async function trainAgility(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state?.player) throw new Error('No initial state');

    const startXp = ctx.sdk.getSkill('Agility')?.experience ?? 0;
    const startLevel = ctx.sdk.getSkill('Agility')?.baseLevel ?? 1;

    console.log(`=== Agility Training ===`);
    console.log(`Starting Level: ${startLevel}`);
    console.log(`Starting XP: ${startXp}`);
    console.log(`Target: Level ${TARGET_LEVEL} (${XP_FOR_LEVEL_10} XP)`);
    console.log(`Position: (${state.player.worldX}, ${state.player.worldZ})`);

    // Train at the agility course
    let lapsCompleted = 0;
    const MAX_LAPS = 20; // Safety limit

    while (lapsCompleted < MAX_LAPS) {
        const currentXp = ctx.sdk.getSkill('Agility')?.experience ?? 0;
        const currentLevel = ctx.sdk.getSkill('Agility')?.baseLevel ?? 1;

        // Check if we've reached our goal
        if (currentLevel >= TARGET_LEVEL) {
            console.log(`\nGoal reached! Level ${currentLevel}`);
            break;
        }

        console.log(`\n--- Lap ${lapsCompleted + 1} ---`);
        console.log(`Level: ${currentLevel}, XP: ${currentXp}/${XP_FOR_LEVEL_10}`);

        // Walk to the course START (Log balance location) before each lap
        const LOG_BALANCE_LOCATION = { x: 2474, z: 3438 };
        let distToStart = distanceTo(ctx, LOG_BALANCE_LOCATION.x, LOG_BALANCE_LOCATION.z);

        if (distToStart > 10) {
            console.log(`Walking to course start (Log balance)...`);
            await ctx.bot.walkTo(LOG_BALANCE_LOCATION.x, LOG_BALANCE_LOCATION.z, 5);
            distToStart = distanceTo(ctx, LOG_BALANCE_LOCATION.x, LOG_BALANCE_LOCATION.z);

            // If still far, use raw walk
            if (distToStart > 10) {
                console.log(`  Using raw walk to course start...`);
                await ctx.sdk.sendWalk(LOG_BALANCE_LOCATION.x, LOG_BALANCE_LOCATION.z, true);
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        await completeLap(ctx);
        lapsCompleted++;

        // Dismiss any level-up dialogs
        await ctx.bot.dismissBlockingUI();
    }

    // Final summary
    const finalXp = ctx.sdk.getSkill('Agility')?.experience ?? 0;
    const finalLevel = ctx.sdk.getSkill('Agility')?.baseLevel ?? 1;

    console.log('\n=== Training Complete ===');
    console.log(`Level: ${startLevel} -> ${finalLevel}`);
    console.log(`XP: ${startXp} -> ${finalXp} (+${finalXp - startXp})`);
    console.log(`Laps completed: ${lapsCompleted}`);

    if (finalLevel < TARGET_LEVEL) {
        console.warn(`Did not reach target level ${TARGET_LEVEL}`);
    }
}

async function main() {
    const username = `ag${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.GNOME_AGILITY);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            await trainAgility(ctx);
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 10 * 60 * 1000,  // 10 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
