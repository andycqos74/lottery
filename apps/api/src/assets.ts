/**
 * Static assets for the public pages: the stylesheet, the script, the club's
 * images and the self-hosted fonts in apps/api/public/.
 *
 * Served by the API itself rather than a CDN because the site runs under a
 * strict CSP (script-src/style-src/font-src 'self', deploy/compose/Caddyfile).
 * Every file is read once at startup into a fixed map, so a request can only
 * ever name a file that was there at boot — there is no path to traverse.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

interface Asset {
  readonly body: Buffer;
  readonly type: string;
  readonly etag: string;
}

function load(dir: string, into: Map<string, Asset>): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      load(full, into);
      continue;
    }
    const type = CONTENT_TYPES[extname(name).toLowerCase()];
    if (!type) continue;
    const body = readFileSync(full);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    into.set(relative(PUBLIC_DIR, full).split(sep).join('/'), { body, type, etag });
  }
}

const ASSETS = new Map<string, Asset>();
load(PUBLIC_DIR, ASSETS);

/**
 * `/assets/<path>?v=<content hash>` for the files whose content changes with a
 * deploy, so a browser holding last week's stylesheet fetches the new one.
 */
export function assetUrl(path: string): string {
  const asset = ASSETS.get(path);
  return asset ? `/assets/${path}?v=${asset.etag.slice(1, 9)}` : `/assets/${path}`;
}

export function registerAssets(app: FastifyInstance): void {
  app.get('/assets/*', async (request, reply) => {
    const path = (request.params as { '*': string })['*'];
    const asset = ASSETS.get(path);
    if (!asset) return reply.code(404).send({ error: 'not found' });
    if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send();
    return reply
      .header('content-type', asset.type)
      .header('etag', asset.etag)
      // Versioned URLs (the CSS and JS) and fonts never change in place; images
      // are long-lived too, but revalidate via the ETag after a day.
      .header('cache-control', path.endsWith('.css') || path.endsWith('.js') || path.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400')
      .send(asset.body);
  });
}
