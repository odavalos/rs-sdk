/**
 * Al Kharid Travel Script
 *
 * Simple approach: sell bow at general store, pay gate toll
 */

import { runScript, type ScriptContext } from '../../sdk/runner';
import { generateSave, TestPresets } from '../../sdk/test/utils/save-generator';
import { launchBotWithSDK } from '../../sdk/test/utils/browser';

// Helper to walk using raw sendWalk (bypasses broken pathfinding)
async function rawWalkTo(ctx: ScriptContext, targetX: number, targetZ: number, timeout = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        const pos = ctx.sdk.getState()?.player;
        if (!pos) break;

        const dist = Math.sqrt(Math.pow(targetX - pos.worldX, 2) + Math.pow(targetZ - pos.worldZ, 2));
        if (dist <= 3) {
            console.log(`Arrived at (${pos.worldX}, ${pos.worldZ})`);
            return true;
        }

        await ctx.sdk.sendWalk(targetX, targetZ, true);
        await new Promise(r => setTimeout(r, 600));
    }

    const finalPos = ctx.sdk.getState()?.player;
    console.log(`Walk ended at (${finalPos?.worldX}, ${finalPos?.worldZ})`);
    return false;
}

async function main() {
    const username = `ak${Math.random().toString(36).slice(2, 7)}`;
    await generateSave(username, TestPresets.LUMBRIDGE_SPAWN);
    const session = await launchBotWithSDK(username, { usePuppeteer: true });

    try {
        await runScript(async (ctx) => {
            const pos = ctx.sdk.getState()?.player;
            console.log(`Starting at (${pos?.worldX}, ${pos?.worldZ})`);

            if (pos && pos.worldX >= 3270) {
                console.log('Already in Al Kharid!');
                return;
            }

            // 1. Walk to general store
            console.log('Walking to general store...');
            await rawWalkTo(ctx, 3212, 3246);

            // Find and open shop
            const npcs = ctx.sdk.getState()?.nearbyNpcs;
            console.log(`Nearby: ${npcs?.slice(0, 5).map((n: any) => n.name).join(', ')}`);

            const openResult = await ctx.bot.openShop(/shop.*keeper/i);
            if (!openResult.success) {
                throw new Error(`Shop failed: ${openResult.message}`);
            }

            // Sell bow
            const sellResult = await ctx.bot.sellToShop(/shortbow/i, 'all');
            console.log(sellResult.message);
            await ctx.bot.closeShop();

            const coins = ctx.sdk.findInventoryItem(/^coins$/i);
            console.log(`Have ${coins?.count ?? 0}gp`);

            // 2. Walk to gate
            console.log('Walking to gate...');
            await rawWalkTo(ctx, 3267, 3228);

            // 3. Talk to border guard
            console.log('Talking to guard...');
            const talkResult = await ctx.bot.talkTo(/border guard/i);
            if (!talkResult.success) {
                // Try generic guard
                const talkResult2 = await ctx.bot.talkTo(/guard/i);
                if (!talkResult2.success) {
                    throw new Error(`Guard not found`);
                }
            }

            // 4. Pay toll via dialog
            let paid = false;
            for (let i = 0; i < 20; i++) {
                const state = ctx.sdk.getState();
                if (!state?.dialog.isOpen) {
                    if (paid) break; // Dialog closed after paying
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }

                const opts = state.dialog.options;
                console.log(`Dialog: ${opts.map((o: any) => o.text).join(' | ') || '(continue)'}`);

                const yesOpt = opts.find((o: any) => /yes/i.test(o.text));
                if (yesOpt) {
                    console.log('Paying toll...');
                    await ctx.sdk.sendClickDialog(yesOpt.index);
                    paid = true;
                    await new Promise(r => setTimeout(r, 500));
                    continue; // Keep clearing dialogs
                }

                await ctx.sdk.sendClickDialog(0);
                await new Promise(r => setTimeout(r, 400));
            }

            // Make sure dialog is closed
            for (let i = 0; i < 5 && ctx.sdk.getState()?.dialog.isOpen; i++) {
                await ctx.sdk.sendClickDialog(0);
                await new Promise(r => setTimeout(r, 300));
            }

            // 5. Walk through gate into Al Kharid
            console.log('Walking through gate...');
            await rawWalkTo(ctx, 3275, 3227);

            const finalPos = ctx.sdk.getState()?.player;
            if (finalPos && finalPos.worldX >= 3270) {
                console.log(`Success! At (${finalPos.worldX}, ${finalPos.worldZ})`);
            } else {
                throw new Error(`Failed at (${finalPos?.worldX}, ${finalPos?.worldZ})`);
            }
        }, {
            connection: { bot: session.bot, sdk: session.sdk },
            timeout: 2 * 60 * 1000,
        });
    } finally {
        await session.cleanup();
    }
}

main().catch(console.error);
