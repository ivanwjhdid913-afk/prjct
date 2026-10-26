import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const root = fileURLToPath(new URL('../../', import.meta.url));
function configuration(files: string[]) {
  return JSON.parse(execFileSync('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json'], { cwd: root, encoding: 'utf8' }));
}

test('normal Compose startup keeps PostgreSQL internal and preserves the existing data volume', () => {
  const config = configuration(['compose.yaml']);
  expect(config.services.db.ports ?? []).toEqual([]);
  expect(config.services.db.volumes.map((volume: { source: string; target: string }) => [volume.source, volume.target])).toContainEqual(['water-data', '/var/lib/postgresql']);
  expect(config.volumes['water-data'].name).toBe('water-observation_water-data');
  expect(config.services.backend.environment.POSTGRES_HOST).toBe('db');
  expect(String(config.services.backend.environment.POSTGRES_PORT)).toBe('5432');
});

test('optional database access is explicit, loopback only and configurable', () => {
  const config = configuration(['compose.yaml', 'compose.db-access.yaml']);
  expect(config.services.db.ports).toHaveLength(1);
  expect(config.services.db.ports[0].host_ip).toBe('127.0.0.1');
  expect(config.services.db.ports[0].target).toBe(5432);
  expect(String(config.services.db.ports[0].published)).toBe(process.env.POSTGRES_HOST_PORT ?? '55432');
  expect(config.volumes['water-data'].name).toBe('water-observation_water-data');
});

test('Windows checkout preserves prepared river bytes for offline rebuilds', () => {
  const artifacts = join(root, '.cache', 'checkout-tests');
  mkdirSync(artifacts, { recursive: true });
  const destination = mkdtempSync(join(artifacts, 'river-'));
  const paths = [
    'backend/data/river_reach.geojson',
    'backend/data/reaches/voronezh-zheltye-peski_reach.geojson',
    'backend/data/reaches/voronezh-zheltye-peski_downstream.geojson',
  ];
  execFileSync('git', ['-c', 'core.autocrlf=true', 'checkout-index', `--prefix=${destination.replaceAll('\\', '/')}/`, '--', ...paths], { cwd: root });
  for (const path of paths) {
    const checkedOut = readFileSync(join(destination, path));
    expect(checkedOut.includes(13), `${path} must retain LF endings`).toBe(false);
    expect(checkedOut.equals(readFileSync(join(root, path))), `${path} bytes differ after Windows checkout`).toBe(true);
  }
});
