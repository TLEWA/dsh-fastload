import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const pkgUrl = new URL('../package.json', import.meta.url);
const clientUrl = new URL('../client.js', import.meta.url);

test('package exposes the web client half', async () => {
  const pkg = JSON.parse(await readFile(pkgUrl, 'utf8'));
  assert.equal(pkg.exports['./client'], './client.js');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.dsh.client.immediately, true);
  assert.ok(pkg.files.includes('client.js'));
});

test('client registers a module and keeps the auto-fill contract', async () => {
  const source = await readFile(clientUrl, 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, /id: MODULE_ID/);
  assert.match(source, /data-fastload-autoloaded/);
  assert.match(source, /data-step-process-content/);
  assert.match(source, /conversation\.chat\.flow/);
  assert.match(source, /beginPaging|加载更早|Load older|olderButtonOf/);
});
