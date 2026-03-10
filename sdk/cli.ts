#!/usr/bin/env bun
// SDK CLI - Bot state inspection
//
// Usage:
//   bun sdk/cli.ts <botname>                         # One-shot state dump
//   bun sdk/cli.ts <botname> state                   # Same as above
//   bun sdk/cli.ts <botname> state --json            # Raw JSON state
//
// Legacy:
//   bun sdk/cli.ts <username> <password>             # Direct credentials
//   bun sdk/cli.ts <username> <password> --server <url>

import { BotSDK, deriveGatewayUrl } from './index';
import { formatWorldState } from './formatter';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

function printUsage() {
    console.log(`
SDK CLI - Bot state inspection

Usage:
  bun sdk/cli.ts <botname>                    # One-shot state dump
  bun sdk/cli.ts <botname> state              # Same as above
  bun sdk/cli.ts <botname> state --json       # Raw JSON state

Options:
  --server <host>   Server hostname (default: from bot.env or rs-sdk-demo.fly.dev)
  --timeout <ms>    Connection timeout in ms (default: 5000)
  --json            Output raw JSON (for state subcommand)
  --help            Show this help

Examples:
  bun sdk/cli.ts mybot
  bun sdk/cli.ts mybot state --json

To execute code on a bot, use the MCP execute_code tool instead.
`.trim());
}

/**
 * Try to load credentials from bots/<name>/bot.env
 */
function tryLoadBotEnv(botName: string): { username: string; password: string; server?: string } | null {
    const envPath = join(process.cwd(), 'bots', botName, 'bot.env');
    if (!existsSync(envPath)) return null;

    const content = readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};

    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
            env[trimmed.slice(0, eqIndex).trim()] = trimmed.slice(eqIndex + 1).trim();
        }
    }

    if (!env.BOT_USERNAME || !env.PASSWORD) return null;

    return {
        username: env.BOT_USERNAME,
        password: env.PASSWORD,
        server: env.SERVER
    };
}

// --- State dump ---

async function fetchState(botName: string, flags: { server: string; timeout: number; json: boolean }) {
    let username = process.env.BOT_USERNAME || process.env.USERNAME || '';
    let password = process.env.PASSWORD || '';
    let server = flags.server || process.env.SERVER || '';
    const timeout = flags.timeout;

    // Try to load from bots/<name>/bot.env
    const botEnv = tryLoadBotEnv(botName);
    if (botEnv) {
        username = botEnv.username;
        password = botEnv.password;
        if (botEnv.server && !server) server = botEnv.server;
    } else {
        username = botName;
    }

    if (!server) server = 'rs-sdk-demo.fly.dev';

    const isLocal = server === 'localhost' || server.startsWith('localhost:');

    if (!username) {
        console.error('Error: Username required');
        process.exit(1);
    }

    if (!password && !isLocal) {
        console.error('Error: Password required for remote servers');
        process.exit(1);
    }

    const gatewayUrl = deriveGatewayUrl(server);

    const sdk = new BotSDK({
        botUsername: username,
        password,
        gatewayUrl,
        autoReconnect: false,
        autoLaunchBrowser: false
    });

    try {
        const connectTimeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout')), timeout);
        });
        await Promise.race([sdk.connect(), connectTimeout]);
    } catch (err: any) {
        console.error(`Error: Failed to connect to ${gatewayUrl}`);
        console.error(`  ${err.message}`);
        process.exit(1);
    }

    try {
        await sdk.waitForCondition(s => s !== null, Math.min(timeout, 3000));
    } catch {
        // State may not arrive
    }

    const state = sdk.getState();
    const stateAge = sdk.getStateAge();

    if (!state) {
        console.error(`Error: No state received for '${username}'`);
        console.error(`  Bot may not be connected to the game server.`);
        console.error(`  Connect the bot first via the web client.`);
        sdk.disconnect();
        process.exit(1);
    }

    if (flags.json) {
        console.log(JSON.stringify(state, null, 2));
        sdk.disconnect();
        process.exit(0);
    }

    const STALE_THRESHOLD = 5000;
    if (stateAge > STALE_THRESHOLD) {
        console.log(`⚠ STALE DATA: State is ${Math.round(stateAge / 1000)}s old (bot may not be actively connected)\n`);
    }

    if (!state.inGame) {
        console.log(`Note: Bot '${username}' is not in-game (tick: ${state.tick})`);
        console.log(`Last known state:\n`);
    }

    console.log(formatWorldState(state, stateAge));

    sdk.disconnect();
    process.exit(0);
}

// --- Main ---

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(0);
    }

    // Parse flags first, collect positional args
    let server = '';
    let timeout = 5000;
    let jsonFlag = false;

    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        } else if (arg === '--server' || arg === '-s') {
            server = args[++i] ?? server;
        } else if (arg === '--timeout' || arg === '-t') {
            timeout = parseInt(args[++i] ?? '5000', 10);
        } else if (arg === '--json') {
            jsonFlag = true;
        } else if (!arg.startsWith('-')) {
            positional.push(arg);
        }
    }

    // First positional is always the bot name
    const botName = positional[0];
    if (!botName) {
        console.error('Error: Bot name required');
        printUsage();
        process.exit(1);
    }

    const flags = { server, timeout, json: jsonFlag };

    // Second positional might be 'state' or a password (legacy)
    const second = positional[1];

    if (second === 'exec') {
        console.error('Error: The "exec" subcommand has been removed.');
        console.error('Use the MCP execute_code tool instead.');
        process.exit(1);
    }

    if (second === 'stop') {
        console.error('Error: The "stop" subcommand has been removed (daemon no longer exists).');
        process.exit(1);
    }

    if (!second || second === 'state') {
        // State dump (default)
        await fetchState(botName, flags);
    } else {
        // Legacy mode: second positional is a password
        const username = botName;
        const password = second;

        if (!server) server = 'rs-sdk-demo.fly.dev';
        const gatewayUrl = deriveGatewayUrl(server);

        const sdk = new BotSDK({
            botUsername: username,
            password,
            gatewayUrl,
            autoReconnect: false,
            autoLaunchBrowser: false
        });

        try {
            const connectTimeout = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Connection timeout')), timeout);
            });
            await Promise.race([sdk.connect(), connectTimeout]);
        } catch (err: any) {
            console.error(`Error: Failed to connect to ${gatewayUrl}`);
            console.error(`  ${err.message}`);
            process.exit(1);
        }

        try {
            await sdk.waitForCondition(s => s !== null, Math.min(timeout, 3000));
        } catch {}

        const state = sdk.getState();
        const stateAge = sdk.getStateAge();

        if (!state) {
            console.error(`Error: No state received for '${username}'`);
            sdk.disconnect();
            process.exit(1);
        }

        if (jsonFlag) {
            console.log(JSON.stringify(state, null, 2));
        } else {
            const STALE_THRESHOLD = 5000;
            if (stateAge > STALE_THRESHOLD) {
                console.log(`⚠ STALE DATA: State is ${Math.round(stateAge / 1000)}s old (bot may not be actively connected)\n`);
            }
            if (!state.inGame) {
                console.log(`Note: Bot '${username}' is not in-game (tick: ${state.tick})`);
                console.log(`Last known state:\n`);
            }
            console.log(formatWorldState(state, stateAge));
        }

        sdk.disconnect();
        process.exit(0);
    }
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
