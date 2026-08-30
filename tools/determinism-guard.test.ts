/**
 * Proves the determinism enforcement actually works.
 *
 * The claim "T-6.1 is enforced by the build, not by code review" is only true
 * while the lint rules are wired up correctly. A silent regression here — a
 * renamed directory, a reordered config block, an `eslint-disable` that creeps
 * in — would remove the guarantee without removing anyone's belief in it.
 *
 * So this test writes a deliberately non-deterministic workflow to a temporary
 * file, runs the real ESLint configuration against it, and asserts it is
 * rejected. Slow (it spawns ESLint), but it is the only way to test a build-time
 * guarantee from inside the test suite.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const probe = resolve(root, 'packages/workflows/src/__determinism_probe.ts');

afterEach(async () => {
  await rm(probe, { force: true });
});

async function lintProbe(source: string): Promise<string> {
  await writeFile(probe, source, 'utf8');
  try {
    await exec('pnpm', ['exec', 'eslint', probe], { cwd: root });
    return '';   // clean: ESLint exits 0
  } catch (error) {
    return String((error as { stdout?: string }).stdout ?? '');
  }
}

describe('T-6.1 / T-6.2 / T-6.3 — workflow determinism is enforced by the build', () => {
  it('rejects randomness in workflow code — the rule that protects the draw', async () => {
    const output = await lintProbe(`export function W(): number { return Math.random(); }\n`);
    expect(output).toMatch(/Math\.random.*restricted/s);
    expect(output).toMatch(/T-6\.1/);
  }, 60_000);

  it('rejects wall-clock time in workflow code', async () => {
    const output = await lintProbe(`export function W(): number { return Date.now(); }\n`);
    expect(output).toMatch(/T-6\.2/);
  }, 60_000);

  it('rejects crypto in workflow code', async () => {
    const output = await lintProbe(`import { randomUUID } from 'node:crypto';\nexport const W = () => randomUUID();\n`);
    expect(output).toMatch(/T-6\.1|T-6\.3/);
  }, 60_000);

  it('rejects a database import in workflow code (T-1.2)', async () => {
    const output = await lintProbe(`import { createPool } from '@qosfc/db';\nexport const W = () => createPool;\n`);
    expect(output).toMatch(/workflow code reads no database/);
  }, 60_000);

  it('accepts deterministic workflow code', async () => {
    const output = await lintProbe(
      `import { allocate, basisPoints, pence } from '@qosfc/domain';\n` +
        `export function W() {\n` +
        `  return allocate(pence(104000), {\n` +
        `    prizeBp: basisPoints(5000), goodCauseBp: basisPoints(4000), adminBp: basisPoints(1000),\n` +
        `  });\n` +
        `}\n`,
    );
    expect(output).toBe('');
  }, 60_000);
});
