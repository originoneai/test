import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
test('scaffold starts and serves the application and health endpoint', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    assert.equal((await (await fetch(url + '/healthz')).json()).ok, true);
    assert.match(await (await fetch(url)).text(), /Issue tracker/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
