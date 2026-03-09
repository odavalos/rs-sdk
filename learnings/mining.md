# Mining

Successful patterns for mining automation.

## Finding Rocks

Rocks are **locations** (not NPCs). Filter for rocks with a "Mine" option:

```typescript
const rock = state.nearbyLocs
    .filter(loc => /rocks?/i.test(loc.name))
    .filter(loc => loc.optionsWithIndex.some(o => /^mine$/i.test(o.text)))
    .sort((a, b) => a.distance - b.distance)[0];
```

## Mining Action

```typescript
// Walk closer if needed (interaction range is ~3 tiles)
if (rock.distance > 3) {
    await ctx.sdk.sendWalk(rock.x, rock.z, true);
    await new Promise(r => setTimeout(r, 1000));
}

const mineOpt = rock.optionsWithIndex.find(o => /^mine$/i.test(o.text));
await ctx.sdk.sendInteractLoc(rock.x, rock.z, rock.id, mineOpt.opIndex);
```

## Detecting Mining Activity

Animation ID 625 indicates active mining:

```typescript
const isMining = state.player?.animId === 625;
const isIdle = state.player?.animId === -1;
```




**Note:** Al Kharid mine is full of Lvl 14 scorpions. Combat 27+ with defensive style is enough to survive while mining. The scorpion fights actually train Defence passively.

## Reliable Locations

| Location | Coordinates | Notes |
|----------|-------------|-------|
| SE Varrock mine | (3285, 3365) | Copper, tin, iron |
| Al Kharid mine | (3295, 3287) | Iron, coal, gold, silver, mithril, tin. Scorpions! |
| Lumbridge Swamp mine | - | Interactions fail silently, avoid |

**Getting to Al Kharid mine from Lumbridge:** Pay 10gp toll at gate (3268, 3227), walk NE. Dialog sequence: continue → continue → "Yes, ok." (index 3) → continue.

## Counting Ore

```typescript
function countOre(ctx): number {
    const state = ctx.sdk.getState();
    if (!state) return 0;
    return state.inventory
        .filter(i => /ore$/i.test(i.name))
        .reduce((sum, i) => sum + i.count, 0);
}
```

## Drop When Full

```typescript
if (state.inventory.length >= 28) {
    const ores = state.inventory.filter(i => /ore$/i.test(i.name));
    for (const ore of ores) {
        await ctx.sdk.sendDropItem(ore.slot);
        await new Promise(r => setTimeout(r, 100));
    }
}
```
