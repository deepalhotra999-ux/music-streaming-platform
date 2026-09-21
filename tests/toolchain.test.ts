import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

describe('monorepo wiring', () => {
  it('declares npm workspaces covering services, workers and packages', () => {
    const pkg = readJson('package.json');
    expect(pkg.private).toBe(true);
    expect(pkg.workspaces).toEqual(
      expect.arrayContaining(['services/*', 'workers/*', 'packages/*']),
    );
  });

  it('each workspace has a package.json and tsconfig.json', () => {
    for (const dir of ['services/api', 'workers/transcoder', 'packages/contracts']) {
      expect(existsSync(join(root, dir, 'package.json'))).toBe(true);
      expect(existsSync(join(root, dir, 'tsconfig.json'))).toBe(true);
    }
  });

  it('enforces strict TypeScript in the base config', () => {
    const base = readJson('tsconfig.base.json');
    expect(base.compilerOptions.strict).toBe(true);
  });

  it('pins lint and format configs at the repo root', () => {
    expect(existsSync(join(root, 'eslint.config.mjs'))).toBe(true);
    expect(existsSync(join(root, '.prettierrc.json'))).toBe(true);
  });

  it('runs on a supported Node version', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
  });
});
