/**
 * Black-box test support: boot one of the real runnable processes (admin
 * console, member API, codec server) exactly as production does — `tsx` on its
 * entry point, configured only through environment variables — and talk to it
 * over HTTP.
 *
 * Route handlers in these apps are registered at module top level and call
 * `listen()` on import, so an in-process `app.inject()` is not available. A
 * child process is also the more honest test: it proves the boot-time env
 * checks, cookie signing, content-type parsers and auth hook as deployed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface RunningServer {
  readonly baseUrl: string;
  /** Everything the process wrote to stdout/stderr — attach to a failure message. */
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export async function startServer(entry: string, env: Record<string, string>, readyPath = '/healthz'): Promise<RunningServer> {
  const port = await freePort();
  const child: ChildProcess = spawn(resolve(REPO_ROOT, 'node_modules/.bin/tsx'), [resolve(REPO_ROOT, entry)], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${entry} exited during startup (code ${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(baseUrl + readyPath);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`${entry} did not become ready within 30s:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    baseUrl,
    output: () => output,
    stop: () =>
      new Promise<void>((done) => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
      }),
  };
}

/**
 * The smallest cookie jar that works for these apps: one origin, path=/,
 * signed cookies passed back verbatim. A cleared cookie (empty value or
 * Max-Age=0 / past Expires) is dropped.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const cleared =
        value === '' ||
        attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) ||
        attrs.some((a) => /^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]!) <= Date.now());
      if (cleared) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [k, v] of this.cookies) copy.set(k, v);
    return copy;
  }
}

/** fetch() that never follows redirects and keeps cookies in `jar`. */
export async function http(
  baseUrl: string,
  path: string,
  init: { method?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string>; jar?: CookieJar } = {},
): Promise<{ status: number; location: string | null; text: string; res: Response }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  if (init.jar) {
    const cookie = init.jar.header();
    if (cookie) headers['cookie'] = cookie;
  }
  const res = await fetch(baseUrl + path, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    redirect: 'manual',
  });
  init.jar?.absorb(res);
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), res };
}
