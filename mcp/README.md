# RS-Agent MCP Server

MCP (Model Context Protocol) server for controlling RS-Agent bots. Supports multiple simultaneous bot connections.

## Quick Start (Claude Code)

Claude Code auto-discovers the MCP server via `.mcp.json`. Just:

1. **Install dependencies:**
   ```bash
   cd mcp && bun install
   ```

2. **Create a bot (if you haven't):**
   ```bash
   bun bots/create-bot.ts mybot
   ```

3. **Open the project in Claude Code** — it will prompt you to approve the MCP server.

4. **Control your bot:**
   ```
   Execute code on "mybot" to chop some trees
   ```

## Tools

### `execute_code`
Execute TypeScript code on a bot. Auto-connects on first use using credentials from `bots/{name}/bot.env`.

```typescript
execute_code({
  bot_name: "mybot",
  code: `
    const tree = sdk.findNearbyLoc(/^tree$/i);
    if (tree) {
      const result = await bot.chopTree(tree);
      console.log('Chopped:', result);
    }
    return sdk.getInventory();
  `
})
```

### `list_bots`
List all connected bots and their status.

```typescript
list_bots()
// Returns: { bots: [{ name: "mybot", username: "mybot", connected: true }], count: 1 }
```

### `disconnect_bot`
Disconnect a connected bot.

```typescript
disconnect_bot({ name: "mybot" })
```

## Resources

The server exposes API documentation as resources:

- `file://api/bot.ts` — High-level bot actions (chopTree, walkTo, attackNpc, etc.)
- `file://api/sdk.ts` — Low-level SDK (getState, sendWalk, findNearbyNpc, etc.)

Read these to discover available methods.

## Multiple Bots

Control multiple bots simultaneously — each auto-connects on first use:

```typescript
// Execute on different bots (auto-connects each)
execute_code({
  bot_name: "woodcutter",
  code: "await bot.chopTree()"
})

execute_code({
  bot_name: "miner",
  code: "await bot.mineRock()"
})
```

## Manual Setup (without auto-discovery)

If you're not using Claude Code's auto-discovery, add to your MCP client config:

```json
{
  "mcpServers": {
    "rs-agent": {
      "command": "bun",
      "args": ["run", "/path/to/rs-agent/Server/mcp/server.ts"]
    }
  }
}
```

Or run directly for testing:

```bash
bun run mcp/server.ts
```

## Architecture

```
mcp/
├── server.ts           # MCP server (stdio transport)
├── package.json        # MCP SDK dependency
└── api/
    ├── index.ts        # BotManager - manages multiple connections
    ├── bot.ts          # High-level BotActions API docs
    └── sdk.ts          # Low-level BotSDK API docs
```

## Troubleshooting

**"Bot not found"**
- Create the bot first: `bun bots/create-bot.ts {name}`
- Check `bots/{name}/bot.env` exists

**"Bot is not connected"**
- Use `connect_bot` before `execute_code`
- Use `list_bots` to see connected bots

**"Connection failed"**
- Check the gateway is running
- Verify credentials in `bots/{name}/bot.env`

**MCP server not appearing in Claude Code**
- Run `bun install` in the mcp directory
- Check `.mcp.json` exists at project root
- Restart Claude Code

## API Reference

See `api/bot.ts` and `api/sdk.ts` for full API documentation.

### High-Level Bot Actions

- Movement: `walkTo(x, z)`
- Skills: `chopTree()`, `mineRock()`, `fish()`, `cookFood()`
- Combat: `attackNpc(target)`, `eatFood(food)`
- Banking: `openBank()`, `depositItem()`, `withdrawItem()`
- Shopping: `openShop()`, `buyFromShop()`, `sellToShop()`
- Crafting: `smithAtAnvil()`, `fletchLogs()`, `craftLeather()`
- UI: `dismissBlockingUI()`, `skipTutorial()`

### Low-Level SDK Methods

- State: `getState()`, `getStateAge()`
- Inventory: `getInventory()`, `findInventoryItem(pattern)`
- NPCs: `getNearbyNpcs()`, `findNearbyNpc(pattern)`
- Locations: `getNearbyLocs()`, `findNearbyLoc(pattern)`
- Actions: `sendWalk()`, `sendInteractLoc()`, `sendInteractNpc()`
- Utilities: `findPath()`, `waitForCondition()`
