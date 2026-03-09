import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

/**
 * Test if ladders/stairs work in other buildings.
 * If Wizard Tower ladder works, we can work around the Lumbridge Castle stair bug.
 */
async function main() {
    const username = `lt${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx: ScriptContext) => {
            console.log('=== Ladder/Stair Functionality Test ===');

            const startPos = ctx.sdk.getState()?.player;
            console.log(`Starting at: (${startPos?.worldX}, ${startPos?.worldZ}), floor: ${startPos?.level}`);

            // Walk toward Wizard's Tower (south of Draynor Village)
            // It's a long walk, so let's use waypoints
            const waypoints = [
                [3222, 3218], // Start
                [3230, 3220], // East
                [3230, 3200], // South
                [3220, 3180], // Continue south
                [3200, 3170], // West-ish toward Draynor
                [3150, 3170], // West to Draynor area
                [3109, 3168], // Wizard Tower entrance
            ];

            for (const [x, z] of waypoints) {
                console.log(`Walking to (${x}, ${z})...`);
                try {
                    await ctx.bot.walkTo(x!, z!);
                    await new Promise(r => setTimeout(r, 500));

                    const pos = ctx.sdk.getState()?.player;
                    console.log(`  -> Now at (${pos?.worldX}, ${pos?.worldZ})`);
                } catch (e) {
                    console.warn(`Walk failed: ${e}`);
                }
            }

            // Check if we're near Wizard's Tower
            const pos = ctx.sdk.getState()?.player;
            console.log(`\nFinal position: (${pos?.worldX}, ${pos?.worldZ})`);

            // Look for ladder
            const ladders = ctx.sdk.getState()?.nearbyLocs.filter(l => /ladder/i.test(l.name)) ?? [];
            console.log(`Ladders found: ${ladders.map(l => `${l.name}@(${l.x},${l.z}) dist=${l.distance} opts:[${l.optionsWithIndex.map(o => o.text).join(',')}]`).join('; ')}`);

            // Look for any climbable object
            const climbables = ctx.sdk.getState()?.nearbyLocs.filter(l =>
                l.optionsWithIndex.some(o => /climb/i.test(o.text))
            ) ?? [];
            console.log(`Climbable objects: ${climbables.map(l => `${l.name}@(${l.x},${l.z})`).join(', ')}`);

            // Try to enter the tower
            console.log('\nTrying to enter Wizard Tower...');
            await ctx.bot.walkTo(3109, 3168);
            await new Promise(r => setTimeout(r, 500));

            // Check for door
            const door = ctx.sdk.getState()?.nearbyLocs.find(l =>
                /door/i.test(l.name) &&
                l.optionsWithIndex.some(o => /open/i.test(o.text))
            );
            if (door) {
                console.log(`Opening door at (${door.x}, ${door.z})...`);
                const opt = door.optionsWithIndex.find(o => /open/i.test(o.text));
                if (opt) {
                    await ctx.sdk.sendInteractLoc(door.x, door.z, door.id, opt.opIndex);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            // Walk inside
            await ctx.bot.walkTo(3104, 3162);
            await new Promise(r => setTimeout(r, 500));

            // Find ladder to basement
            const ladder = ctx.sdk.getState()?.nearbyLocs.find(l =>
                /ladder/i.test(l.name) &&
                l.optionsWithIndex.some(o => /climb.*down/i.test(o.text))
            );

            if (!ladder) {
                console.warn('No ladder found inside Wizard Tower');

                // Log what IS nearby
                const nearby = ctx.sdk.getState()?.nearbyLocs.slice(0, 10) ?? [];
                console.log(`Nearby objects: ${nearby.map(l => `${l.name}@(${l.x},${l.z})`).join(', ')}`);
                return;
            }

            console.log(`\nFound ladder at (${ladder.x}, ${ladder.z}), distance=${ladder.distance}`);
            console.log(`Options: ${ladder.optionsWithIndex.map(o => `${o.opIndex}:${o.text}`).join(', ')}`);

            // Try climbing down
            const priorLevel = ctx.sdk.getState()?.player?.level ?? 0;
            console.log(`\nAttempting to climb down (current floor: ${priorLevel})...`);

            const climbOpt = ladder.optionsWithIndex.find(o => /climb.*down/i.test(o.text));
            if (climbOpt) {
                const result = await ctx.sdk.sendInteractLoc(ladder.x, ladder.z, ladder.id, climbOpt.opIndex);
                console.log(`Interaction result: ${JSON.stringify(result)}`);

                // Wait for floor change
                for (let i = 0; i < 5; i++) {
                    await new Promise(r => setTimeout(r, 1000));
                    const currLevel = ctx.sdk.getState()?.player?.level ?? 0;
                    const currPos = ctx.sdk.getState()?.player;
                    console.log(`  Check ${i+1}: floor=${currLevel}, pos=(${currPos?.worldX}, ${currPos?.worldZ})`);

                    if (currLevel !== priorLevel) {
                        console.log('\n*** LADDER WORKS! Floor changed! ***');

                        // Look for Sedridor in basement
                        const npcs = ctx.sdk.getState()?.nearbyNpcs.slice(0, 5) ?? [];
                        console.log(`NPCs in basement: ${npcs.map(n => n.name).join(', ')}`);

                        return;
                    }
                }

                // Check game messages
                const msgs = ctx.sdk.getState()?.gameMessages ?? [];
                console.log(`\nGame messages: ${msgs.slice(-5).map(m => m.text).join(' | ')}`);

                if (msgs.some(m => /can't reach/i.test(m.text))) {
                    console.warn('LADDER ALSO FAILS with "can\'t reach" - this is a widespread bug');
                }
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 120_000,
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
