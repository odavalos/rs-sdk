// Backfill hiscore_bank from existing player save files.
// Only processes accounts in the top 5% by playtime (from hiscore_large).
// Usage: bun tools/backfill-bank-hiscores.ts [profile]

import fs from 'fs';
import fsp from 'fs/promises';

import { db, toDbDate } from '#/db/query.js';
import { PlayerLoading } from '#/engine/entity/PlayerLoading.js';
import InvType from '#/cache/config/InvType.js';
import ObjType from '#/cache/config/ObjType.js';
import Packet from '#/io/Packet.js';

// Load cache data
InvType.load('data/pack');
ObjType.load('data/pack');

const bankInvId = InvType.getId('bank');
if (bankInvId === -1) {
    console.error('Could not find bank inventory type');
    process.exit(1);
}

const profile = process.argv[2] || 'main';
const saveDir = `data/players/${profile}`;

if (!fs.existsSync(saveDir)) {
    console.error(`Save directory not found: ${saveDir}`);
    process.exit(1);
}

// Build set of eligible accounts (top 5% by playtime)
const allPlaytimes = await db
    .selectFrom('hiscore_large')
    .innerJoin('account', 'account.id', 'hiscore_large.account_id')
    .select(['account.id', 'account.username', 'account.staffmodlevel', 'hiscore_large.playtime'])
    .where('hiscore_large.type', '=', 0)
    .where('hiscore_large.profile', '=', profile)
    .where('account.staffmodlevel', '<=', 1)
    .orderBy('hiscore_large.playtime', 'desc')
    .execute();

const cutoffIndex = Math.ceil(allPlaytimes.length * 0.05);
const cutoffPlaytime = allPlaytimes[cutoffIndex - 1]?.playtime ?? 0;

const eligibleAccounts = new Map<string, number>();
for (const row of allPlaytimes) {
    if (row.playtime >= cutoffPlaytime) {
        eligibleAccounts.set(row.username, row.id);
    }
}

console.log(`Total accounts with hiscores: ${allPlaytimes.length}`);
console.log(`Top 5% cutoff: ${cutoffPlaytime} ticks playtime (${eligibleAccounts.size} accounts eligible)`);

const files = (await fsp.readdir(saveDir)).filter(f => f.endsWith('.sav'));
console.log(`Found ${files.length} save files in ${saveDir}`);

let processed = 0;
let inserted = 0;
let skipped = 0;
let errors = 0;

for (const file of files) {
    const username = file.replace('.sav', '');

    const accountId = eligibleAccounts.get(username);
    if (accountId === undefined) {
        skipped++;
        continue;
    }

    try {
        const raw = await fsp.readFile(`${saveDir}/${file}`);
        if (!PlayerLoading.verify(new Packet(raw))) {
            console.warn(`  [SKIP] ${username}: invalid save file`);
            skipped++;
            continue;
        }

        const player = PlayerLoading.load(username, new Packet(raw), null);
        const bank = player.getInventory(bankInvId);
        if (!bank) {
            skipped++;
            continue;
        }

        const items: { id: number; name: string; value: number; count: number }[] = [];
        let totalValue = 0;
        for (let slot = 0; slot < bank.capacity; slot++) {
            const item = bank.get(slot);
            if (item) {
                const objType = ObjType.get(item.id);
                if (objType) {
                    const value = objType.cost * item.count;
                    items.push({ id: item.id, name: objType.name || `obj_${item.id}`, value, count: item.count });
                    totalValue += value;
                }
            }
        }

        if (items.length === 0) {
            skipped++;
            continue;
        }

        // Sort by value descending
        items.sort((a, b) => b.value - a.value);

        const itemsJson = JSON.stringify(items);
        const existing = await db.selectFrom('hiscore_bank').select('value').where('account_id', '=', accountId).where('profile', '=', profile).executeTakeFirst();
        if (existing) {
            await db.updateTable('hiscore_bank').set({ value: totalValue, items: itemsJson, date: toDbDate(new Date()) }).where('account_id', '=', accountId).where('profile', '=', profile).execute();
        } else {
            await db.insertInto('hiscore_bank').values({ account_id: accountId, profile, value: totalValue, items: itemsJson }).execute();
        }

        inserted++;
        processed++;
        console.log(`  [OK] ${username}: ${totalValue.toLocaleString()} gp (${items.length} items)`);
    } catch (err: any) {
        console.error(`  [ERROR] ${username}: ${err.message}`);
        errors++;
    }
}

console.log(`\nDone! Processed: ${processed}, Inserted/Updated: ${inserted}, Skipped: ${skipped}, Errors: ${errors}`);
process.exit(0);
