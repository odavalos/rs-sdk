/**
 * Mining Training Script v9
 *
 * Goal: Maximize Mining level in 5 minutes
 *
 * Strategy:
 * - Start at Lumbridge (natural spawn) with tutorial-complete gear
 * - Walk north to SE Varrock mine (no toll needed, no aggressive mobs)
 * - Mine copper/tin rocks continuously
 * - Drop ore when inventory is full
 *
 * v9 Changes:
 * - Switch to SE Varrock mine (safer, no scorpions)
 * - No need to sell items or pay toll
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// SE Varrock mine - has copper and tin, no aggressive monsters
const TARGET_MINE = { x: 3285, z: 3365 };

// Waypoints from Lumbridge to SE Varrock mine
const WAYPOINTS_TO_MINE = [
    { x: 3222, z: 3230 },  // North from Lumbridge
    { x: 3222, z: 3250 },  // Continue north
    { x: 3230, z: 3280 },  // Northeast
    { x: 3250, z: 3310 },  // Continue NE
    { x: 3270, z: 3340 },  // Getting closer
    { x: 3285, z: 3360 },  // Near mine
    TARGET_MINE,           // SE Varrock mine
];

// Get mining level and XP
function getMiningStats(ctx: ScriptContext): { level: number; xp: number } {
    const state = ctx.sdk.getState();
    const mining = state?.skills.find(s => s.name === 'Mining');
    return {
        level: mining?.baseLevel ?? 1,
        xp: mining?.experience ?? 0
    };
}

// Log mining progress
function logProgress(ctx: ScriptContext, label: string): void {
    const stats = getMiningStats(ctx);
    const invCount = ctx.sdk.getState()?.inventory.length ?? 0;
    console.log(`[${label}] Mining Lv${stats.level} (${stats.xp} XP) | Inv: ${invCount}/28`);
}

// Rock info with ore type from prospecting
interface RockInfo {
    x: number;
    z: number;
    id: number;
    name: string;
    mineOpIndex: number;
    prospectOpIndex: number;
    distance: number;
    oreType?: string;  // Set after prospecting
}

// Find all nearby rocks with Mine option
function findRocks(ctx: ScriptContext): RockInfo[] {
    const state = ctx.sdk.getState();
    if (!state) return [];

    const rocks: RockInfo[] = [];
    for (const loc of state.nearbyLocs) {
        if (/rocks?/i.test(loc.name) && !/rockslide/i.test(loc.name)) {
            const mineOpt = loc.optionsWithIndex.find(o => /mine/i.test(o.text));
            const prospectOpt = loc.optionsWithIndex.find(o => /prospect/i.test(o.text));
            if (mineOpt && prospectOpt) {
                rocks.push({
                    x: loc.x,
                    z: loc.z,
                    id: loc.id,
                    name: loc.name,
                    mineOpIndex: mineOpt.opIndex,
                    prospectOpIndex: prospectOpt.opIndex,
                    distance: loc.distance
                });
            }
        }
    }
    // Sort by distance
    return rocks.sort((a, b) => a.distance - b.distance);
}

// Prospect a rock to find ore type
async function prospectRock(ctx: ScriptContext, rock: RockInfo): Promise<string | null> {
    const { sdk } = ctx;
    const startTick = ctx.sdk.getState()?.tick ?? 0;

    await sdk.sendInteractLoc(rock.x, rock.z, rock.id, rock.prospectOpIndex);

    // Wait for prospect message
    try {
        const state = await sdk.waitForCondition(s => {
            for (const msg of s.gameMessages) {
                if (msg.tick > startTick) {
                    const text = msg.text.toLowerCase();
                    // Look for "This rock contains X" messages
                    if (text.includes('rock contains') || text.includes('ore')) {
                        return true;
                    }
                    if (text.includes('no ore') || text.includes('nothing')) {
                        return true;
                    }
                }
            }
            return false;
        }, 5000);

        // Extract ore type from message
        for (const msg of state.gameMessages) {
            if (msg.tick > startTick) {
                const text = msg.text.toLowerCase();
                if (text.includes('copper')) return 'copper';
                if (text.includes('tin')) return 'tin';
                if (text.includes('iron')) return 'iron';
                if (text.includes('gold')) return 'gold';
                if (text.includes('silver')) return 'silver';
                if (text.includes('coal')) return 'coal';
                if (text.includes('mithril')) return 'mithril';
                if (text.includes('adamant')) return 'adamant';
                if (text.includes('rune') || text.includes('runite')) return 'runite';
                if (text.includes('no ore') || text.includes('nothing')) return 'empty';
            }
        }
    } catch {
        return null;
    }
    return null;
}

// Known mineable ores by level
const MINEABLE_AT_LEVEL: Record<number, string[]> = {
    1: ['copper', 'tin'],
    15: ['iron'],
    20: ['silver'],
    30: ['coal'],
    40: ['gold'],
    55: ['mithril'],
    70: ['adamant'],
    85: ['runite']
};

function canMineOre(oreType: string, miningLevel: number): boolean {
    for (const [reqLevel, ores] of Object.entries(MINEABLE_AT_LEVEL)) {
        if (ores.includes(oreType) && miningLevel >= parseInt(reqLevel)) {
            return true;
        }
    }
    return false;
}

// Drop all ore from inventory
async function dropOre(ctx: ScriptContext): Promise<number> {
    const state = ctx.sdk.getState();
    if (!state) return 0;

    let dropped = 0;
    for (const item of state.inventory) {
        // Drop copper, tin, iron ore (and any other ore)
        if (/ore/i.test(item.name)) {
            await ctx.sdk.sendDropItem(item.slot);
            dropped++;
        }
    }
    return dropped;
}

// Check if inventory is full
function isInventoryFull(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    return (state?.inventory.length ?? 0) >= 28;
}

// Walk using small direct steps (bypasses server pathfinder issues)
async function walkSmallSteps(
    ctx: ScriptContext,
    targetX: number,
    targetZ: number,
    stepSize: number = 12
): Promise<{ x: number; z: number }> {
    const { sdk } = ctx;

    const MAX_STEPS = 20;
    for (let step = 0; step < MAX_STEPS; step++) {
        const state = ctx.sdk.getState();
        if (!state?.player) break;

        const currentX = state.player.worldX;
        const currentZ = state.player.worldZ;
        const dist = Math.sqrt(Math.pow(targetX - currentX, 2) + Math.pow(targetZ - currentZ, 2));

        if (dist <= 3) {
            return { x: currentX, z: currentZ };
        }

        // Calculate next step towards target
        const ratio = Math.min(stepSize / dist, 1);
        const nextX = Math.round(currentX + (targetX - currentX) * ratio);
        const nextZ = Math.round(currentZ + (targetZ - currentZ) * ratio);

        // Use direct walk command (client-side pathfinding)
        await sdk.sendWalk(nextX, nextZ, true);

        // Wait for movement
        await new Promise(r => setTimeout(r, 800));

        // Check if we moved
        const newState = ctx.sdk.getState();
        if (newState?.player) {
            const movedDist = Math.sqrt(
                Math.pow(newState.player.worldX - currentX, 2) +
                Math.pow(newState.player.worldZ - currentZ, 2)
            );
            if (movedDist < 1) {
                // Stuck - try a slightly different direction
                const jitterX = nextX + Math.round((Math.random() - 0.5) * 4);
                const jitterZ = nextZ + Math.round((Math.random() - 0.5) * 4);
                await sdk.sendWalk(jitterX, jitterZ, true);
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }

    const finalState = ctx.sdk.getState();
    return {
        x: finalState?.player?.worldX ?? 0,
        z: finalState?.player?.worldZ ?? 0
    };
}

// Walk to a destination using waypoints with small steps
// Returns early if rocks are found along the way
async function walkWithWaypoints(
    ctx: ScriptContext,
    waypoints: Array<{ x: number; z: number }>,
    label: string
): Promise<{ foundRocks: boolean }> {
    const { bot, sdk } = ctx;

    for (let i = 0; i < waypoints.length; i++) {
        const wp = waypoints[i];
        if (!wp) continue;
        const state = ctx.sdk.getState();
        const playerPos = state?.player ? `(${state.player.worldX}, ${state.player.worldZ})` : '?';
        console.log(`Walking to waypoint ${i + 1}/${waypoints.length}: (${wp.x}, ${wp.z}) from ${playerPos}`);

        // Don't stop early for rocks - we need to reach the copper/tin area
        // (The mine has gold/coal near the entrance, copper/tin further in)

        // Try bot.walkTo first (uses server pathfinder)
        const result = await bot.walkTo(wp.x, wp.z);

        let newState = ctx.sdk.getState();
        let currentX = newState?.player?.worldX ?? 0;
        let currentZ = newState?.player?.worldZ ?? 0;
        let dist = Math.sqrt(Math.pow(wp.x - currentX, 2) + Math.pow(wp.z - currentZ, 2));

        // If walkTo failed and we're still far, try small steps
        if (!result.success && dist > 5) {
            console.log(`Server pathfinder failed, trying small steps...`);
            const pos = await walkSmallSteps(ctx, wp.x, wp.z);
            currentX = pos.x;
            currentZ = pos.z;
            dist = Math.sqrt(Math.pow(wp.x - currentX, 2) + Math.pow(wp.z - currentZ, 2));

            // Continue walking to target - don't stop for rocks
        }

        console.log(`Waypoint ${i + 1}: now at (${currentX}, ${currentZ}), ${dist.toFixed(0)} tiles from target`);

        // Brief pause between waypoints
        await new Promise(r => setTimeout(r, 300));
    }

    const finalState = ctx.sdk.getState();
    const finalPos = finalState?.player ? `(${finalState.player.worldX}, ${finalState.player.worldZ})` : '?';
    console.log(`${label} - final position: ${finalPos}`);
    return { foundRocks: false };
}

async function main() {
    // Create fresh account
    const username = `mn${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);

    // Launch browser
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            const { bot, sdk } = ctx;

            // Log initial state
            logProgress(ctx, 'START');
            let oresMined = 0;
            let lastXp = getMiningStats(ctx).xp;

            // Check for pickaxe
            let pickaxe = sdk.findInventoryItem(/pickaxe/i);
            if (!pickaxe) {
                // Check if already equipped
                pickaxe = sdk.findEquipmentItem(/pickaxe/i);
                if (!pickaxe) {
                    console.log('ERROR: No pickaxe in inventory or equipped!');
                    return;
                }
                console.log(`Found ${pickaxe.name} already equipped`);
            } else {
                console.log(`Found ${pickaxe.name} in inventory - equipping it...`);
                const equipResult = await bot.equipItem(pickaxe);
                if (equipResult.success) {
                    console.log('Pickaxe equipped!');
                } else {
                    console.log(`Failed to equip pickaxe: ${equipResult.message} - will try mining anyway`);
                }
            }

            // Walk to SE Varrock mine (safer than Al Kharid - no scorpions)
            console.log('Walking to SE Varrock mine...');
            await walkWithWaypoints(ctx, WAYPOINTS_TO_MINE, 'ARRIVED AT MINE');

            // Check current position and look for rocks
            const posState = ctx.sdk.getState();
            const currentPos = posState?.player
                ? { x: posState.player.worldX, z: posState.player.worldZ }
                : TARGET_MINE;

            // Update mine location to where we actually ended up (for drift detection)
            const actualMineLocation = { ...currentPos };

            // Look for rocks in the area - if none found, try walking around
            let rocks = findRocks(ctx);
            if (rocks.length === 0) {
                console.log(`No rocks at (${currentPos.x}, ${currentPos.z}), searching nearby...`);
                // Try walking to nearby locations to find rocks
                const searchOffsets = [
                    { x: -10, z: 0 }, { x: 10, z: 0 },
                    { x: 0, z: -10 }, { x: 0, z: 10 },
                    { x: -15, z: -15 }, { x: 15, z: -15 },
                ];
                for (const offset of searchOffsets) {
                    const searchX = currentPos.x + offset.x;
                    const searchZ = currentPos.z + offset.z;
                    console.log(`Searching at (${searchX}, ${searchZ})...`);
                    await walkSmallSteps(ctx, searchX, searchZ, 8);

                    rocks = findRocks(ctx);
                    if (rocks.length > 0) {
                        const newPos = ctx.sdk.getState()?.player;
                        if (newPos) {
                            actualMineLocation.x = newPos.worldX;
                            actualMineLocation.z = newPos.worldZ;
                        }
                        console.log(`Found ${rocks.length} rocks at (${actualMineLocation.x}, ${actualMineLocation.z})!`);
                        break;
                    }
                }
            }

            logProgress(ctx, 'READY TO MINE');

            // Cache of rock ID -> ore type (from prospecting)
            const oreTypeCache = new Map<number, string>();
            let consecutiveFailures = 0;
            const MAX_FAILURES = 5;

            // Main mining loop
            while (true) {
                const state = ctx.sdk.getState();
                if (!state?.player) {
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                }

                const currentStats = getMiningStats(ctx);

                // Check for XP gain (successful mine)
                if (currentStats.xp > lastXp) {
                    const xpGained = currentStats.xp - lastXp;
                    oresMined++;
                    lastXp = currentStats.xp;
                    consecutiveFailures = 0;  // Reset on success

                    if (oresMined % 5 === 0) {
                        logProgress(ctx, `MINED #${oresMined}`);
                    }
                }

                // Dismiss any dialogs (level-up messages)
                if (state.dialog.isOpen) {
                    await sdk.sendClickDialog(0);
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }

                // Check if inventory is full - drop ore
                if (isInventoryFull(ctx)) {
                    console.log('Inventory full, dropping ore...');
                    const dropped = await dropOre(ctx);
                    console.log(`Dropped ${dropped} ores`);
                    continue;
                }

                // Find rocks
                const rocks = findRocks(ctx);
                if (rocks.length === 0) {
                    // Return to mine center
                    const player = state.player;
                    const distFromMine = Math.sqrt(
                        Math.pow(player.worldX - actualMineLocation.x, 2) +
                        Math.pow(player.worldZ - actualMineLocation.z, 2)
                    );
                    if (distFromMine > 5) {
                        console.log(`No rocks nearby, returning to mine center (${distFromMine.toFixed(0)} tiles away)...`);
                        await walkSmallSteps(ctx, actualMineLocation.x, actualMineLocation.z, 8);
                    } else {
                        console.log('No rocks nearby, waiting for respawn...');
                        await new Promise(r => setTimeout(r, 1500));
                    }
                    continue;
                }

                // Find a mineable rock - only prospect rocks within reasonable range
                const MAX_PROSPECT_DIST = 8;
                let targetRock: RockInfo | null = null;

                for (const rock of rocks) {
                    // Check cache first
                    const cachedOre = oreTypeCache.get(rock.id);
                    if (cachedOre) {
                        if (cachedOre === 'empty') continue;
                        if (!canMineOre(cachedOre, currentStats.level)) {
                            continue;  // Skip rocks we can't mine
                        }
                        targetRock = rock;
                        targetRock.oreType = cachedOre;
                        break;
                    }

                    // Only prospect nearby rocks (don't walk too far)
                    if (rock.distance > MAX_PROSPECT_DIST) {
                        continue;
                    }

                    // Unknown rock - prospect it
                    console.log(`Prospecting rock id=${rock.id} dist=${rock.distance}...`);
                    const oreType = await prospectRock(ctx, rock);
                    if (oreType) {
                        console.log(`Rock ${rock.id} = ${oreType}`);
                        oreTypeCache.set(rock.id, oreType);

                        if (oreType !== 'empty' && canMineOre(oreType, currentStats.level)) {
                            targetRock = rock;
                            targetRock.oreType = oreType;
                            break;
                        }
                    }
                }

                if (!targetRock) {
                    consecutiveFailures++;
                    console.log(`No mineable rocks found (failure ${consecutiveFailures}/${MAX_FAILURES})`);

                    if (consecutiveFailures >= MAX_FAILURES) {
                        console.log('ERROR: No mineable rocks at this location! Need copper/tin at level 1.');
                        console.log('Cached ore types: ' + Array.from(oreTypeCache.entries()).map(([id, ore]) => `${id}=${ore}`).join(', '));
                        return;  // Exit script - wrong mine location
                    }

                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                // Mine the rock
                console.log(`Mining ${targetRock.oreType} rock id=${targetRock.id} dist=${targetRock.distance}`);
                const startXp = currentStats.xp;
                const startTick = ctx.sdk.getState()?.tick ?? 0;

                const mineResult = await sdk.sendInteractLoc(
                    targetRock.x, targetRock.z, targetRock.id, targetRock.mineOpIndex
                );

                if (!mineResult.success) {
                    console.log(`Mine action failed: ${mineResult.message}`);
                    consecutiveFailures++;
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                // Wait for mining to complete
                try {
                    await sdk.waitForCondition(state => {
                        // Success: XP gained
                        const miningXp = state.skills.find(s => s.name === 'Mining')?.experience ?? 0;
                        if (miningXp > startXp) return true;

                        // Rock depleted
                        const rockNow = state.nearbyLocs.find(l =>
                            l.x === targetRock!.x && l.z === targetRock!.z
                        );
                        if (!rockNow || rockNow.id !== targetRock!.id) return true;

                        // Dismiss dialogs
                        if (state.dialog.isOpen) {
                            sdk.sendClickDialog(0).catch(() => {});
                        }

                        return false;
                    }, 8000);

                    consecutiveFailures = 0;
                } catch {
                    consecutiveFailures++;
                    console.log(`Mining timeout (failure ${consecutiveFailures}/${MAX_FAILURES})`);
                }

                await new Promise(r => setTimeout(r, 200));
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
