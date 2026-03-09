/**
 * Varrock Travel Script
 *
 * Goal: Navigate from Lumbridge to Varrock using bot.walkTo()
 *
 * Uses waypoint-based navigation for long distances (>30 tiles).
 * Route goes through the cow field area and up to Varrock.
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Varrock West Bank area (ground floor, reliable destination)
const VARROCK = { x: 3185, z: 3436 };

// Waypoints from Lumbridge to Varrock (~210 tiles total)
// Each segment is 20-30 tiles to avoid pathfinding issues
const WAYPOINTS = [
    { x: 3232, z: 3245, name: 'North of Lumbridge' },       // First step north
    { x: 3250, z: 3270, name: 'Near cow field' },           // East to avoid castle
    { x: 3260, z: 3300, name: 'North of cow field' },       // Continue north
    { x: 3255, z: 3330, name: 'Champion Guild area' },      // Past champions guild
    { x: 3245, z: 3360, name: 'South Varrock' },            // Approaching Varrock
    { x: 3230, z: 3390, name: 'Varrock south entrance' },   // South of Varrock
    { x: 3210, z: 3420, name: 'Near Varrock square' },      // Into Varrock
    { x: 3185, z: 3436, name: 'Varrock West Bank' },        // Final destination
];

// Arrival tolerance in tiles
const WAYPOINT_TOLERANCE = 8;
const FINAL_TOLERANCE = 10;

/**
 * Check if we've reached Varrock (north of z=3400)
 */
function isInVarrock(ctx: ScriptContext): boolean {
    const state = ctx.sdk.getState();
    if (!state?.player) return false;
    return state.player.worldZ >= 3400;
}

/**
 * Get distance between player and a point
 */
function distanceTo(ctx: ScriptContext, x: number, z: number): number {
    const state = ctx.sdk.getState();
    if (!state?.player) return Infinity;
    const dx = x - state.player.worldX;
    const dz = z - state.player.worldZ;
    return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Walk to a waypoint with retries
 */
async function walkToWaypoint(
    ctx: ScriptContext,
    x: number,
    z: number,
    name: string,
    tolerance: number
): Promise<boolean> {
    const MAX_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const dist = distanceTo(ctx, x, z);
        if (dist <= tolerance) {
            console.log(`Already at ${name}`);
            return true;
        }

        console.log(`Walking to ${name} (${x}, ${z}) - attempt ${attempt}/${MAX_ATTEMPTS}`);
        const result = await ctx.bot.walkTo(x, z, tolerance);

        const newDist = distanceTo(ctx, x, z);
        if (newDist <= tolerance) {
            console.log(`Reached ${name}`);
            return true;
        }

        if (!result.success) {
            console.warn(`Walk attempt ${attempt} failed: ${result.message}`);
        }

        // Small delay before retry
        await new Promise(r => setTimeout(r, 500));
    }

    const finalDist = distanceTo(ctx, x, z);
    console.warn(`Could not reach ${name} - distance: ${finalDist.toFixed(0)} tiles`);
    return finalDist <= tolerance * 2; // Allow some leeway to continue
}

/**
 * Main travel function using waypoints
 */
async function travelToVarrock(ctx: ScriptContext): Promise<void> {
    const state = ctx.sdk.getState();
    if (!state?.player) throw new Error('No initial state');

    const startX = state.player.worldX;
    const startZ = state.player.worldZ;
    const startTime = Date.now();

    console.log(`Start: (${startX}, ${startZ})`);
    console.log(`Destination: Varrock (${VARROCK.x}, ${VARROCK.z})`);
    console.log(`Total waypoints: ${WAYPOINTS.length}`);

    if (isInVarrock(ctx)) {
        console.log('Already in Varrock!');
        return;
    }

    // Follow waypoints
    for (let i = 0; i < WAYPOINTS.length; i++) {
        const wp = WAYPOINTS[i];
        if (!wp) continue;

        // Skip waypoints we're already past
        if (distanceTo(ctx, wp.x, wp.z) <= WAYPOINT_TOLERANCE) {
            console.log(`Skipping ${wp.name} - already there`);
            continue;
        }

        const isLast = i === WAYPOINTS.length - 1;
        const tolerance = isLast ? FINAL_TOLERANCE : WAYPOINT_TOLERANCE;

        const success = await walkToWaypoint(ctx, wp.x, wp.z, wp.name, tolerance);

        if (!success && !isInVarrock(ctx)) {
            // Log position and continue trying
            const pos = ctx.sdk.getState()?.player;
            console.warn(`Stuck at (${pos?.worldX}, ${pos?.worldZ}) - trying next waypoint`);
        }

        // Check if we've reached Varrock early
        if (isInVarrock(ctx)) {
            console.log('Reached Varrock area!');
            break;
        }
    }

    const elapsed = (Date.now() - startTime) / 1000;
    const endState = ctx.sdk.getState();
    const endX = endState?.player?.worldX ?? 0;
    const endZ = endState?.player?.worldZ ?? 0;
    const finalDist = distanceTo(ctx, VARROCK.x, VARROCK.z);

    console.log(`End position: (${endX}, ${endZ})`);
    console.log(`Distance to target: ${finalDist.toFixed(0)} tiles`);
    console.log(`Time: ${elapsed.toFixed(1)}s`);

    if (!isInVarrock(ctx) && finalDist > FINAL_TOLERANCE * 2) {
        throw new Error(`Failed to reach Varrock - stuck at (${endX}, ${endZ})`);
    }

    console.log('Successfully reached Varrock!');
}

// Run the script
async function main() {
    const username = `vt${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            await travelToVarrock(ctx);
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 3 * 60 * 1000,  // 3 minutes
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
