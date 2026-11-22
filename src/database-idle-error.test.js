import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('idle pool disconnect is handled without exposing driver credentials', () => {
  const source = new URL('./database.js', import.meta.url).href;
  const script = `import { pool } from ${JSON.stringify(source)};
    pool.emit('error', Object.assign(new Error('postgres://secret:password@private-host/db'), { code: 'ECONNRESET' }));
    console.log('still-running'); await pool.end();`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://localhost/test',
      PROFINO_DB_TLS_MODE: 'disable', PROFINO_DATABASE_TLS: 'disabled' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still-running/);
  assert.match(result.stderr, /idle client error/);
  assert.doesNotMatch(result.stderr, /secret|password|private-host|postgres:\/\//);
});
