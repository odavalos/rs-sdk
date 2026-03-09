/**
 * Thieving Training Script v1
 *
 * Goal: Train Thieving to level 10+ from a fresh Lumbridge spawn
 *
 * Strategy:
 * 1. Find Men/Women NPCs in Lumbridge
 * 2. Pickpocket them repeatedly
 * 3. Handle stuns (brief delay after failed pickpocket)
 * 4. Continue until level 10
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Get thieving stats
function getThievingStats(ctx: ScriptContext): { level: number; xp: number } {
    const state = ctx.sdk.getState();
    const thieving = state?.skills.find(s => s.name === 'Thieving');
    return {
        level: thieving?.baseLevel ?? 1,
        xp: thieving?.experience ?? 0
    };
}

// Find a Man or Woman NPC to pickpocket
function findTarget(ctx: ScriptContext): { npc: { index: number; name: string; optionsWithIndex: Array<{ text: string; opIndex: number }> }; pickpocketOpt: { text: string; opIndex: number } } | null {
    const state = ctx.sdk.getState();
    if (!state) return null;

    // Look for Man or Woman NPCs
    for (const npc of state.nearbyNpcs) {
        if (/^(man|woman)$/i.test(npc.name)) {
            const pickpocketOpt = npc.optionsWithIndex.find(o => /pickpocket/i.test(o.text));
            if (pickpocketOpt) {
                return { npc, pickpocketOpt };
            }
        }
    }
    return null;
}

// Pickpocket a target NPC
async function pickpocket(ctx: ScriptContext): Promise<boolean> {
    const target = findTarget(ctx);
    if (!target) {
        console.log('No pickpocket target found');
        return false;
    }

    const { npc, pickpocketOpt } = target;
    const xpBefore = getThievingStats(ctx).xp;
    const startTick = ctx.sdk.getState()?.tick ?? 0;

    console.log(`Pickpocketing ${npc.name}...`);
    await ctx.sdk.sendInteractNpc(npc.index, pickpocketOpt.opIndex);

    // Wait for XP gain (success) or stun message (failure)
    try {
        const finalState = await ctx.sdk.waitForCondition(state => {
            // Check for XP gain (success)
            const thievingXp = state.skills.find(s => s.name === 'Thieving')?.experience ?? 0;
            if (thievingXp > xpBefore) {
                return true;
            }

            // Check for stun/failure messages
            for (const msg of state.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    if (text.includes('stunned') || text.includes('stun') ||
                        text.includes('caught') || text.includes('failed') ||
                        text.includes("what do you think you're doing")) {
                        return true;
                    }
                }
            }

            // Dismiss level-up dialogs
            if (state.dialog.isOpen) {
                ctx.sdk.sendClickDialog(0).catch(() => {});
            }

            return false;
        }, 8000);

        // Check what happened
        const thievingXpAfter = finalState.skills.find(s => s.name === 'Thieving')?.experience ?? 0;
        if (thievingXpAfter > xpBefore) {
            console.log('Pickpocket success!');
            return true;
        }

        // We got stunned - wait for stun to wear off
        console.log('Stunned! Waiting...');
        await new Promise(r => setTimeout(r, 5000)); // Stun lasts ~5 seconds
        return true; // Still count as progress since we attempted

    } catch {
        console.log('Pickpocket timeout');
        return false;
    }
}

// Main script
async function main() {
    // Create fresh account
    const username = `th${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {

            console.log('=== Thieving Training Script v1 ===');

            const startStats = getThievingStats(ctx);
            console.log(`Starting Thieving: Level ${startStats.level} (${startStats.xp} XP)`);

            let consecutiveFails = 0;

            while (true) {
                const stats = getThievingStats(ctx);

                if (stats.level >= 10) {
                    console.log(`Goal achieved! Thieving level ${stats.level}`);
                    break;
                }

                // Dismiss any blocking dialogs
                const state = ctx.sdk.getState();
                if (state?.dialog.isOpen) {
                    await ctx.sdk.sendClickDialog(0);
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }

                // Check if we have a target nearby
                const target = findTarget(ctx);
                if (!target) {
                    console.log('No targets nearby, walking to Lumbridge center...');
                    // Walk to Lumbridge center where Men/Women spawn
                    await ctx.bot.walkTo(3222, 3218);
                    consecutiveFails++;

                    if (consecutiveFails >= 5) {
                        console.log('Too many consecutive fails, aborting');
                        break;
                    }
                    continue;
                }

                // Attempt pickpocket
                const success = await pickpocket(ctx);
                if (success) {
                    consecutiveFails = 0;
                } else {
                    consecutiveFails++;
                }

                // Small delay between attempts
                await new Promise(r => setTimeout(r, 600));
            }

            const endStats = getThievingStats(ctx);
            console.log(`\n=== Complete: Level ${endStats.level} (${endStats.xp} XP) ===`);
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 15 * 60 * 1000,  // 15 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
