#!/usr/bin/env bun
// SDK CLI - Bot state inspection and code execution
//
// Usage:
//   bun sdk/cli.ts <botname>                         # One-shot state dump
//   bun sdk/cli.ts <botname> state                   # Same as above
//   bun sdk/cli.ts <botname> state --json            # Raw JSON state
//   bun sdk/cli.ts <botname> exec "<code>"           # Execute code via daemon
//   bun sdk/cli.ts <botname> exec                    # Read code from stdin
//   bun sdk/cli.ts <botname> stop                    # Stop the daemon
//
// Legacy:
//   bun sdk/cli.ts <username> <password>             # Direct credentials
//   bun sdk/cli.ts <username> <password> --server <url>

import { BotSDK, deriveGatewayUrl } from './index';
import { formatWorldState } from './formatter';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { connect } from 'net';

const SUBCOMMANDS = ['exec', 'state', 'stop'] as const;
type Subcommand = typeof SUBCOMMANDS[number];

function printUsage() {
    console.log(`
SDK CLI - Bot state inspection and code execution

Usage:
  bun sdk/cli.ts <botname>                    # One-shot state dump
  bun sdk/cli.ts <botname> state              # Same as above
  bun sdk/cli.ts <botname> state --json       # Raw JSON state
  bun sdk/cli.ts <botname> exec "<code>"      # Execute code via daemon
  bun sdk/cli.ts <botname> exec               # Read code from stdin (heredoc friendly)
  bun sdk/cli.ts <botname> stop               # Stop the daemon

Options:
  --server <host>   Server hostname (default: from bot.env or rs-sdk-demo.fly.dev)
  --timeout <ms>    Connection timeout in ms (default: 5000)
  --json            Output raw JSON (for state subcommand)
  --help            Show this help

Examples:
  bun sdk/cli.ts mybot
  bun sdk/cli.ts mybot exec "return sdk.getState()?.player"
  bun sdk/cli.ts mybot exec <<'EOF'
  await bot.chopTree()
  return sdk.getInventory()
  EOF
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

// --- Daemon communication ---

function socketPath(botName: string) {
    return `/tmp/rs-sdk-${botName}.sock`;
}

function pidPath(botName: string) {
    return `/tmp/rs-sdk-${botName}.pid`;
}

function isDaemonRunning(botName: string): boolean {
    const sock = socketPath(botName);
    return existsSync(sock);
}

/**
 * Send a JSON message to the daemon and return the parsed response.
 */
function sendToDaemon(botName: string, msg: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const sock = connect(socketPath(botName));
        let buf = '';

        sock.on('connect', () => {
            sock.write(JSON.stringify(msg) + '\n');
        });

        sock.on('data', (data) => {
            buf += data.toString();
            const nlIndex = buf.indexOf('\n');
            if (nlIndex !== -1) {
                const line = buf.slice(0, nlIndex);
                try {
                    resolve(JSON.parse(line));
                } catch {
                    resolve({ error: 'Invalid response from daemon' });
                }
                sock.end();
            }
        });

        sock.on('error', (err: any) => {
            reject(new Error(`Cannot connect to daemon: ${err.message}`));
        });

        sock.on('end', () => {
            if (buf.trim()) {
                try {
                    resolve(JSON.parse(buf.trim()));
                } catch {
                    reject(new Error('Incomplete response from daemon'));
                }
            }
        });
    });
}

/**
 * Start the daemon as a detached background process.
 * Waits for the socket to appear (up to 30s).
 */
async function ensureDaemon(botName: string): Promise<void> {
    if (isDaemonRunning(botName)) {
        // Verify it's alive with a ping
        try {
            const resp = await sendToDaemon(botName, { type: 'ping' });
            if (resp.ok) return;
        } catch {
            // Socket exists but daemon is dead, clean up
            try { unlinkSync(socketPath(botName)); } catch {}
            try { unlinkSync(pidPath(botName)); } catch {}
        }
    }

    console.error(`Starting daemon for "${botName}"...`);

    const daemonPath = join(__dirname, 'daemon.ts');
    const child = spawn('bun', [daemonPath, botName], {
        detached: true,
        stdio: ['ignore', 'ignore', 'inherit'], // stderr goes to parent for visibility
        cwd: process.cwd(),
    });

    // Track if the child exits early (e.g. bad credentials, missing bot)
    let childExited = false;
    let childExitCode: number | null = null;
    child.on('exit', (code) => {
        childExited = true;
        childExitCode = code;
    });
    child.unref();

    // Wait for socket to appear
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 300));

        if (childExited) {
            throw new Error(`Daemon exited immediately (code ${childExitCode})`);
        }

        if (existsSync(socketPath(botName))) {
            // Give it a moment to be ready, then ping
            await new Promise(r => setTimeout(r, 200));
            try {
                const resp = await sendToDaemon(botName, { type: 'ping' });
                if (resp.ok) {
                    console.error(`Daemon ready (PID: ${child.pid})`);
                    return;
                }
            } catch {
                // Not ready yet, keep waiting
            }
        }
    }

    throw new Error('Daemon failed to start within 30s');
}

/**
 * Read code from stdin (for heredoc/pipe usage).
 */
async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8').trim();
}

// --- Subcommand handlers ---

async function handleExec(botName: string, codeArg: string | undefined, flags: { timeout: number; json: boolean }) {
    let code = codeArg;

    // If no code argument, read from stdin
    if (!code) {
        if (process.stdin.isTTY) {
            console.error('Error: No code provided. Pass code as argument or pipe via stdin.');
            console.error('  bun sdk/cli.ts mybot exec "return 1+1"');
            console.error('  echo "return 1+1" | bun sdk/cli.ts mybot exec');
            process.exit(1);
        }
        code = await readStdin();
        if (!code) {
            console.error('Error: Empty code from stdin');
            process.exit(1);
        }
    }

    await ensureDaemon(botName);

    try {
        const resp = await sendToDaemon(botName, {
            type: 'exec',
            code,
            timeout: flags.timeout,
        });

        if (resp.output) {
            console.log(resp.output);
        }

        process.exit(resp.ok ? 0 : 1);
    } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}

async function handleState(botName: string, flags: { server: string; timeout: number; json: boolean }) {
    // If daemon is running, use it for faster response
    if (isDaemonRunning(botName)) {
        try {
            const resp = await sendToDaemon(botName, { type: 'state', json: flags.json });
            if (resp.ok) {
                if (flags.json) {
                    console.log(JSON.stringify(resp.state, null, 2));
                } else {
                    console.log(resp.output);
                }
                process.exit(0);
            }
        } catch {
            // Daemon dead, fall through to one-shot
        }
    }

    // Fall back to one-shot connection
    await oneshotState(botName, flags);
}

async function handleStop(botName: string) {
    if (isDaemonRunning(botName)) {
        try {
            const resp = await sendToDaemon(botName, { type: 'stop' });
            if (resp.ok) {
                console.log(`Daemon for "${botName}" stopped`);
                process.exit(0);
            }
        } catch {
            // Socket dead, try PID
        }
    }

    // Try killing by PID
    const pidFile = pidPath(botName);
    if (existsSync(pidFile)) {
        const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        try {
            process.kill(pid, 'SIGTERM');
            console.log(`Killed daemon PID ${pid}`);
        } catch {
            console.log(`Daemon PID ${pid} already dead`);
        }
        try { unlinkSync(pidFile); } catch {}
        try { unlinkSync(socketPath(botName)); } catch {}
        process.exit(0);
    }

    console.log(`No daemon running for "${botName}"`);
    process.exit(0);
}

/**
 * Original one-shot state dump (no daemon needed).
 */
async function oneshotState(botName: string, flags: { server: string; timeout: number; json: boolean }) {
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

    // Second positional might be a subcommand or a password (legacy)
    const second = positional[1];
    const subcommand = (second && SUBCOMMANDS.includes(second as Subcommand)) ? second as Subcommand : null;

    const flags = { server, timeout, json: jsonFlag };

    if (subcommand === 'exec') {
        // Code is the third positional arg (if any)
        const codeArg = positional[2];
        await handleExec(botName, codeArg, flags);
    } else if (subcommand === 'stop') {
        await handleStop(botName);
    } else if (subcommand === 'state') {
        await handleState(botName, flags);
    } else if (!second) {
        // No subcommand, no password → default state dump
        await handleState(botName, flags);
    } else {
        // Legacy mode: second positional is a password
        // Re-parse as original: <username> <password>
        const username = botName;
        const password = second;

        if (!server) server = 'rs-sdk-demo.fly.dev';
        const isLocal = server === 'localhost' || server.startsWith('localhost:');
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
