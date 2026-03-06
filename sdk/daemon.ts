#!/usr/bin/env bun
// SDK Daemon - Background process that holds a bot connection alive
// Listens on a Unix socket for commands (exec, state, ping, stop)
//
// Usage:
//   bun sdk/daemon.ts <botname>
//
// Socket: /tmp/rs-sdk-<botname>.sock
// PID:    /tmp/rs-sdk-<botname>.pid

import { BotSDK, deriveGatewayUrl } from './index';
import { BotActions } from './actions';
import { formatWorldState } from './formatter';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

// --- Config ---
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CONNECT_TIMEOUT_MS = 30_000;
const STATE_WAIT_MS = 15_000;

// --- Parse args ---
const botName = process.argv[2];
if (!botName) {
    console.error('Usage: bun sdk/daemon.ts <botname>');
    process.exit(1);
}

const SOCKET_PATH = `/tmp/rs-sdk-${botName}.sock`;
const PID_PATH = `/tmp/rs-sdk-${botName}.pid`;

// --- Load credentials ---
function loadBotEnv(name: string): { username: string; password: string; server?: string } {
    const envPath = join(process.cwd(), 'bots', name, 'bot.env');
    if (!existsSync(envPath)) {
        throw new Error(`Bot "${name}" not found. Create it first with: bun bots/create-bot.ts ${name}`);
    }
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
    if (!env.BOT_USERNAME || !env.PASSWORD) {
        throw new Error(`Missing BOT_USERNAME or PASSWORD in bots/${name}/bot.env`);
    }
    return { username: env.BOT_USERNAME, password: env.PASSWORD, server: env.SERVER };
}

// --- Idle timeout management ---
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        console.error(`[daemon] Idle timeout (${IDLE_TIMEOUT_MS / 1000}s), shutting down`);
        shutdown();
    }, IDLE_TIMEOUT_MS);
}

// --- Cleanup & shutdown ---
let server: ReturnType<typeof Bun.listen> | null = null;
let sdk: BotSDK | null = null;

function cleanup() {
    try { unlinkSync(SOCKET_PATH); } catch {}
    try { unlinkSync(PID_PATH); } catch {}
}

function shutdown() {
    console.error('[daemon] Shutting down...');
    if (idleTimer) clearTimeout(idleTimer);
    if (sdk) {
        sdk.disconnect();
        sdk = null;
    }
    if (server) {
        server.stop(true);
        server = null;
    }
    cleanup();
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// --- Main ---
async function main() {
    const creds = loadBotEnv(botName);
    const gatewayUrl = deriveGatewayUrl(creds.server);

    console.error(`[daemon] Starting for bot "${botName}" (${creds.username})`);
    console.error(`[daemon] Gateway: ${gatewayUrl}`);

    // Connect bot
    sdk = new BotSDK({
        botUsername: creds.username,
        password: creds.password,
        gatewayUrl,
        connectionMode: 'control',
        autoReconnect: true,
        autoLaunchBrowser: 'auto',
    });

    const bot = new BotActions(sdk);

    const connectTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
    });
    await Promise.race([sdk.connect(), connectTimeout]);
    console.error(`[daemon] Connected!`);

    // Wait for initial state
    try {
        await sdk.waitForCondition(() => sdk!.getState() !== null, STATE_WAIT_MS);
        console.error(`[daemon] Initial state received`);
    } catch {
        console.error(`[daemon] Warning: initial state not received within ${STATE_WAIT_MS / 1000}s`);
    }

    // Clean up stale socket
    try { unlinkSync(SOCKET_PATH); } catch {}

    // Write PID file
    writeFileSync(PID_PATH, String(process.pid));

    // Track connection state
    sdk.onConnectionStateChange((state) => {
        if (state === 'connected') {
            console.error(`[daemon] Reconnected`);
        } else {
            console.error(`[daemon] Connection state: ${state}`);
        }
    });

    // --- Code execution ---
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

    async function executeCode(code: string, timeoutMs: number): Promise<{ logs: string[]; result: any; error?: string }> {
        const logs: string[] = [];
        const origLog = console.log;
        const origWarn = console.warn;

        console.log = (...args) => logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));
        console.warn = (...args) => logs.push('[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)).join(' '));

        try {
            // Transpile TS → JS so type annotations, interfaces, etc. are stripped
            let jsCode: string;
            try {
                jsCode = transpiler.transformSync(code);
            } catch (err: any) {
                return { logs, result: undefined, error: `TypeScript syntax error: ${err.message}` };
            }

            const fn = new AsyncFunction('bot', 'sdk', jsCode);

            let timeoutId: ReturnType<typeof setTimeout>;
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error(`Code execution timed out after ${timeoutMs / 1000}s`)), timeoutMs);
            });

            const abortController = new AbortController();
            const signal = abortController.signal;

            const cancellable = <T extends object>(target: T): T =>
                new Proxy(target, {
                    get(obj, prop, receiver) {
                        const value = Reflect.get(obj, prop, receiver);
                        if (typeof value === 'function') {
                            return (...args: any[]) => {
                                if (signal.aborted) throw new Error('Execution cancelled');
                                return value.apply(obj, args);
                            };
                        }
                        return value;
                    }
                });

            let result: any;
            try {
                result = await Promise.race([fn(cancellable(bot), cancellable(sdk!)), timeoutPromise]);
            } finally {
                clearTimeout(timeoutId!);
                if (!signal.aborted) abortController.abort('Execution finished');
            }

            return { logs, result };
        } catch (err: any) {
            return { logs, result: undefined, error: `${err.message}\n${err.stack}` };
        } finally {
            console.log = origLog;
            console.warn = origWarn;
        }
    }

    function buildOutput(execResult: { logs: string[]; result: any; error?: string }): string {
        const parts: string[] = [];

        if (execResult.logs.length > 0) {
            parts.push('── Console ──');
            parts.push(execResult.logs.join('\n'));
        }

        if (execResult.error) {
            parts.push('── Error ──');
            parts.push(execResult.error);
        } else if (execResult.result !== undefined) {
            if (execResult.logs.length > 0) parts.push('');
            parts.push('── Result ──');
            parts.push(JSON.stringify(execResult.result, null, 2));
        }

        // Append world state
        const state = sdk!.getState();
        if (state) {
            parts.push('');
            parts.push('── World State ──');
            parts.push(formatWorldState(state, sdk!.getStateAge()));
        }

        return parts.length > 0 ? parts.join('\n') : '(no output)';
    }

    // --- Socket server ---
    // Buffer per-connection: accumulate data until we get a full newline-delimited JSON message
    const buffers = new Map<object, string>();
    // Pending writes waiting for drain
    const pendingWrites = new Map<object, string[]>();

    /** Write all data to socket, handling backpressure via drain */
    function writeAll(socket: any, data: string) {
        const written = socket.write(data);
        if (written < data.length) {
            const pending = pendingWrites.get(socket) || [];
            pending.push(data.slice(written));
            pendingWrites.set(socket, pending);
        }
    }

    server = Bun.listen({
        unix: SOCKET_PATH,
        socket: {
            open(socket) {
                buffers.set(socket, '');
            },
            drain(socket) {
                // Flush any pending writes
                const pending = pendingWrites.get(socket);
                if (pending && pending.length > 0) {
                    const data = pending.join('');
                    pendingWrites.set(socket, []);
                    writeAll(socket, data);
                }
            },
            async data(socket, data) {
                resetIdleTimer();

                let buf = (buffers.get(socket) || '') + data.toString();
                let nlIndex: number;

                while ((nlIndex = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, nlIndex).trim();
                    buf = buf.slice(nlIndex + 1);

                    if (!line) continue;

                    let msg: any;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        writeAll(socket, JSON.stringify({ error: 'Invalid JSON' }) + '\n');
                        continue;
                    }

                    try {
                        await handleMessage(socket, msg);
                    } catch (err: any) {
                        writeAll(socket, JSON.stringify({ error: err.message }) + '\n');
                    }
                }

                buffers.set(socket, buf);
            },
            close(socket) {
                buffers.delete(socket);
                pendingWrites.delete(socket);
            },
            error(socket, err) {
                console.error(`[daemon] Socket error:`, err.message);
                buffers.delete(socket);
                pendingWrites.delete(socket);
            },
        }
    });

    async function handleMessage(socket: any, msg: any) {
        switch (msg.type) {
            case 'ping': {
                writeAll(socket, JSON.stringify({ ok: true }) + '\n');
                break;
            }
            case 'state': {
                const state = sdk!.getState();
                if (!state) {
                    writeAll(socket, JSON.stringify({ error: 'No state available' }) + '\n');
                    return;
                }
                if (msg.json) {
                    writeAll(socket, JSON.stringify({ ok: true, state, stateAge: sdk!.getStateAge() }) + '\n');
                } else {
                    const formatted = formatWorldState(state, sdk!.getStateAge());
                    writeAll(socket, JSON.stringify({ ok: true, output: formatted }) + '\n');
                }
                break;
            }
            case 'exec': {
                const code = msg.code as string;
                if (!code) {
                    writeAll(socket, JSON.stringify({ error: 'No code provided' }) + '\n');
                    return;
                }
                const timeoutMs = Math.min(Math.max(msg.timeout || 120_000, 1000), 60 * 60 * 1000);
                const execResult = await executeCode(code, timeoutMs);
                const output = buildOutput(execResult);
                writeAll(socket, JSON.stringify({
                    ok: !execResult.error,
                    output,
                    ...(execResult.error ? { error: execResult.error } : {}),
                }) + '\n');
                break;
            }
            case 'stop': {
                writeAll(socket, JSON.stringify({ ok: true, message: 'Shutting down' }) + '\n');
                // Give time for the response to flush
                setTimeout(() => shutdown(), 100);
                break;
            }
            default: {
                writeAll(socket, JSON.stringify({ error: `Unknown message type: ${msg.type}` }) + '\n');
            }
        }
    }

    console.error(`[daemon] Listening on ${SOCKET_PATH} (PID: ${process.pid})`);
    resetIdleTimer();
}

main().catch(err => {
    console.error(`[daemon] Fatal: ${err.message}`);
    cleanup();
    process.exit(1);
});
