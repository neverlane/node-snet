import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const CACHE = resolve(ROOT, 'tests/.cache');
const PEER = resolve(ROOT, 'tests/lua/peer.lua');

let luaEnv: NodeJS.ProcessEnv | null | undefined;

/** Environment with LUA_PATH/LUA_CPATH for luarocks (5.1) + pinned Lua SNET. null if unavailable. */
export function getLuaEnv(): NodeJS.ProcessEnv | null {
  if (luaEnv !== undefined) return luaEnv;
  luaEnv = null;
  if (!existsSync(resolve(CACHE, 'snet/init.lua'))) return null;

  const rocks = spawnSync('luarocks', ['--lua-version=5.1', 'path', '--lr-path'], { encoding: 'utf8' });
  const rocksC = spawnSync('luarocks', ['--lua-version=5.1', 'path', '--lr-cpath'], { encoding: 'utf8' });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LUA_PATH: [`${CACHE}/?.lua`, `${CACHE}/?/init.lua`, rocks.stdout?.trim(), ';'].filter(Boolean).join(';'),
    LUA_CPATH: [rocksC.stdout?.trim(), ';'].filter(Boolean).join(';'),
  };
  const check = spawnSync('luajit', ['-e', 'require("socket"); require("snet")'], { env, encoding: 'utf8' });
  if (check.status !== 0) return null;
  luaEnv = env;
  return env;
}

export const hasLua = () => getLuaEnv() !== null;

export class LuaPeer {
  public lines: string[] = [];
  private waiters: { pred: (l: string) => boolean; res: (l: string) => void }[] = [];
  private stderr = '';

  private constructor(public proc: ChildProcess, public mode: 'server' | 'client', public port: number) {
    let buf = '';
    proc.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.lines.push(line);
        this.waiters = this.waiters.filter((w) => (w.pred(line) ? (w.res(line), false) : true));
      }
    });
    proc.stderr!.setEncoding('utf8').on('data', (c: string) => (this.stderr += c));
  }

  /**
   * @param rcvbuf OS receive buffer for the lua socket. Razor keeps the OS default (~208KB), which
   *   drops bursts of BYPASS packets on the lua side; load tests raise it to measure node-snet itself.
   */
  static async start(mode: 'server' | 'client', port: number, { drain = 200, rcvbuf }: { drain?: number; rcvbuf?: number } = {}): Promise<LuaPeer> {
    const base = getLuaEnv();
    if (!base) throw new Error('Lua SNET not available, run scripts/setup-lua.sh');
    const env = rcvbuf ? { ...base, SNET_LUA_RCVBUF: String(rcvbuf) } : base;
    const proc = spawn('luajit', [PEER, mode, String(port), String(drain)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const peer = new LuaPeer(proc, mode, port);
    await peer.waitLine((l) => l === 'READY', 5000);
    return peer;
  }

  /** Resolves with the first line (already seen or future) matching pred. */
  waitLine(pred: (l: string) => boolean, timeout = 3000): Promise<string> {
    const seen = this.lines.find(pred);
    if (seen) return Promise.resolve(seen);
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.res !== done);
        rej(new Error(`lua ${this.mode}: timeout waiting line.\nstdout:\n${this.lines.slice(-20).join('\n')}\nstderr:\n${this.stderr}`));
      }, timeout);
      const done = (l: string) => (clearTimeout(t), res(l));
      this.waiters.push({ pred, res: done });
    });
  }

  /** Received packets parsed from `RECV id hex` lines. */
  received(packetId?: number): Buffer[] {
    return this.lines
      .filter((l) => l.startsWith('RECV '))
      .map((l) => l.split(' '))
      .filter(([, id]) => packetId === undefined || +id === packetId)
      .map(([, , h]) => Buffer.from(h ?? '', 'hex'));
  }

  waitRecv(packetId: number, timeout = 3000) {
    return this.waitLine((l) => l.startsWith(`RECV ${packetId} `) || l === `RECV ${packetId}`, timeout)
      .then((l) => Buffer.from(l.split(' ')[2] ?? '', 'hex'));
  }

  get stderrText() { return this.stderr; }

  async stop() {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise((r) => this.proc.once('exit', r));
    this.proc.kill('SIGKILL');
    await exited;
  }
}
