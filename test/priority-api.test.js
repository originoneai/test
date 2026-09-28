// HTTP-level coverage for the four-level issue priority (low, normal, high,
// urgent): accepted values and the default, partial patch, the exact priority
// filter composing with status and q, bounded rejections for invalid values,
// malformed JSON and the 16 KiB limit, restart durability and concurrent
// priority patches. Every test boots the real API server with an isolated
// temp DATA_DIR; no live data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BODY_LIMIT = 16 * 1024;

function bootTracker(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const tracker = {
        dataDir,
        base,
        storePath: join(dataDir, 'issues.json'),
        async request(path, options = {}) {
          const response = await fetch(base + path, options);
          const text = await response.text();
          let body = text;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              /* keep raw text */
            }
          }
          return { status: response.status, body, text };
        },
        async postIssue(payload) {
          return this.request('/api/issues', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
        },
        async patchIssue(id, payload) {
          return this.request('/api/issues/' + id, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
        },
        async list(query = '') {
          return this.request('/api/issues' + query);
        },
        async stop() {
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          });
        },
      };
      resolve(tracker);
    });
  });
}

async function withTracker(run) {
  const dataDir = await mkdtemp(join(tmpdir(), 'priority-api-'));
  const tracker = await bootTracker(dataDir);
  try {
    await run(tracker);
  } finally {
    await tracker.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function assertErrorBody(body) {
  assert.ok(body && typeof body === 'object' && body.error, 'error body has error object: ' + JSON.stringify(body));
  assert.equal(typeof body.error.code, 'string', 'error code is a string');
  assert.equal(typeof body.error.message, 'string', 'error message is a string');
  assert.equal('stack' in body.error, false, 'error body has no stack trace');
}

test('create accepts all four priority values and defaults to normal', async () => {
  await withTracker(async (tracker) => {
    for (const priority of PRIORITIES) {
      const created = await tracker.postIssue({ title: 'Priority ' + priority, priority });
      assert.equal(created.status, 201, priority);
      assert.equal(created.body.priority, priority, priority);
      assert.equal(created.body.status, 'open', 'priority does not disturb the status default');
      assert.match(created.body.createdAt, ISO_UTC, priority);
      assert.deepEqual(
        Object.keys(created.body).sort(),
        ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'],
        priority,
      );
    }

    const omitted = await tracker.postIssue({ title: 'No priority given' });
    assert.equal(omitted.status, 201);
    assert.equal(omitted.body.priority, 'normal', 'omitted priority defaults to normal');

    const explicit = await tracker.postIssue({ title: 'Explicit normal', priority: 'normal' });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.priority, 'normal');

    const withDescription = await tracker.postIssue({ title: 'Described', description: 'text', priority: 'urgent' });
    assert.equal(withDescription.body.priority, 'urgent');
    assert.equal(withDescription.body.description, 'text');

    const all = await tracker.list();
    assert.equal(all.body.items.length, 7, 'the seven issues created above are all listed');
    assert.deepEqual(
      all.body.items.map((issue) => issue.priority),
      ['urgent', 'normal', 'normal', 'urgent', 'high', 'normal', 'low'],
      'list echoes every stored priority, newest first',
    );
  });
});

test('priority patch is partial: untouched fields survive and updatedAt advances', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Patch target', description: 'kept', priority: 'low' });
    const id = created.body.id;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const bumped = await tracker.patchIssue(id, { priority: 'urgent' });
    assert.equal(bumped.status, 200);
    assert.equal(bumped.body.priority, 'urgent');
    assert.equal(bumped.body.title, 'Patch target', 'title untouched');
    assert.equal(bumped.body.description, 'kept', 'description untouched');
    assert.equal(bumped.body.status, 'open', 'status untouched');
    assert.equal(bumped.body.createdAt, created.body.createdAt, 'createdAt never changes');
    assert.ok(bumped.body.updatedAt > created.body.updatedAt, 'updatedAt advances');

    const combined = await tracker.patchIssue(id, { priority: 'high', status: 'in_progress' });
    assert.equal(combined.status, 200);
    assert.equal(combined.body.priority, 'high');
    assert.equal(combined.body.status, 'in_progress');

    const roundTrip = await tracker.patchIssue(id, { priority: 'normal' });
    assert.equal(roundTrip.body.priority, 'normal', 'priority can be lowered again');

    const listed = await tracker.list();
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].priority, 'normal', 'the served record reflects the last patch');
  });
});

test('the exact priority filter composes with status and q', async () => {
  await withTracker(async (tracker) => {
    const alpha = await tracker.postIssue({ title: 'Login crash', description: 'urgent auth bug', priority: 'urgent' });
    await tracker.postIssue({ title: 'Login typo', description: 'cosmetic', priority: 'low' });
    const gamma = await tracker.postIssue({ title: 'Export data', description: 'urgent export bug', priority: 'urgent' });
    await tracker.patchIssue(gamma.body.id, { status: 'done' });
    await tracker.postIssue({ title: 'Login crash clone', description: 'also auth', priority: 'high' });

    const byPriority = await tracker.list('?priority=urgent');
    assert.deepEqual(
      byPriority.body.items.map((issue) => issue.title),
      ['Export data', 'Login crash'],
      'priority filter alone, newest first',
    );

    const withStatus = await tracker.list('?priority=urgent&status=done');
    assert.deepEqual(withStatus.body.items.map((issue) => issue.title), ['Export data']);

    const withQuery = await tracker.list('?priority=urgent&q=auth');
    assert.deepEqual(withQuery.body.items.map((issue) => issue.title), ['Login crash']);

    const allThree = await tracker.list('?priority=high&status=open&q=login');
    assert.deepEqual(allThree.body.items.map((issue) => issue.title), ['Login crash clone']);

    const noMatch = await tracker.list('?priority=low&q=export');
    assert.deepEqual(noMatch.body.items, [], 'composable filters may select nothing');

    const lowOnly = await tracker.list('?priority=low');
    assert.deepEqual(lowOnly.body.items.map((issue) => issue.title), ['Login typo']);

    for (const bad of ['critical', 'HIGH', ' ', '0']) {
      const invalid = await tracker.list('?priority=' + encodeURIComponent(bad));
      assert.equal(invalid.status, 400, 'filter value: ' + JSON.stringify(bad));
      assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
      assert.ok(invalid.body.error.message.includes('priority'), 'message names the field: ' + invalid.body.error.message);
    }
  });
});

test('invalid priority on create and patch is a bounded 400 and changes nothing', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Stable', priority: 'high' });
    const before = (await tracker.list()).body.items;

    const badCreates = [
      { title: 'ok', priority: 'critical' },
      { title: 'ok', priority: 'HIGH' },
      { title: 'ok', priority: '' },
      { title: 'ok', priority: null },
      { title: 'ok', priority: 3 },
      { title: 'ok', priority: ['urgent'] },
      { title: 'ok', priority: { toString: null } },
    ];
    for (const payload of badCreates) {
      const response = await tracker.postIssue(payload);
      assert.equal(response.status, 400, 'create: ' + JSON.stringify(payload));
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(response.body.error.message.includes('priority'), 'message names the field');
    }

    const badPatches = [
      { priority: 'critical' },
      { priority: 'urgent ' },
      { priority: null },
      { priority: 42 },
      { priority: { toString: null } },
    ];
    for (const payload of badPatches) {
      const response = await tracker.patchIssue(created.body.id, payload);
      assert.equal(response.status, 400, 'patch: ' + JSON.stringify(payload));
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR');
      assert.ok(response.body.error.message.includes('priority'), 'message names the field');
    }

    // Validation beats routing: an unknown issue with an invalid priority is
    // still a 400 field error, not a 404.
    const unknownInvalid = await tracker.patchIssue('44444444-4444-4444-8444-444444444444', { priority: 'nope' });
    assert.equal(unknownInvalid.status, 400);
    assert.equal(unknownInvalid.body.error.code, 'VALIDATION_ERROR');

    const after = await tracker.list();
    assert.deepEqual(after.body.items, before, 'rejected priority writes changed nothing');

    const stillWorks = await tracker.patchIssue(created.body.id, { priority: 'urgent' });
    assert.equal(stillWorks.status, 200);
    assert.equal(stillWorks.body.priority, 'urgent');
  });
});

test('priority rides the existing unknown-field, malformed-JSON and 16 KiB bounds', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Bounds target', priority: 'normal' });

    const withUnknown = await tracker.postIssue({ title: 'ok', priority: 'high', assignee: 'zoe' });
    assert.equal(withUnknown.status, 400);
    assert.equal(withUnknown.body.error.code, 'VALIDATION_ERROR');
    assert.ok(withUnknown.body.error.message.includes('assignee'), 'unknown field is named');

    const invalidJson = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title":"ok","priority":',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.code, 'INVALID_JSON');

    const prefix = '{"title":"cap","priority":"high","description":"';
    const suffix = '"}';
    const pad = BODY_LIMIT - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const atLimit = prefix + 'a'.repeat(pad) + suffix;
    assert.equal(Buffer.byteLength(atLimit), BODY_LIMIT);
    const boundary = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: atLimit,
    });
    assert.equal(boundary.status, 400, 'a body at the cap is parsed, then fails field validation');
    assert.equal(boundary.body.error.code, 'VALIDATION_ERROR');

    const over = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: atLimit + ' ',
    });
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, 'PAYLOAD_TOO_LARGE');

    const patchOver = await tracker.patchIssue(created.body.id, { priority: 'high', description: 'x'.repeat(BODY_LIMIT) });
    assert.equal(patchOver.status, 413);
    assert.equal(patchOver.body.error.code, 'PAYLOAD_TOO_LARGE');

    const unaffected = await tracker.list();
    assert.equal(unaffected.body.items.length, 1, 'bounded rejections stored nothing');
    assert.equal(unaffected.body.items[0].priority, 'normal');
  });
});

test('priority persists across a restart in fresh data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'priority-api-'));
  try {
    const first = await bootTracker(dataDir);
    const a = await first.postIssue({ title: 'Durable urgent', priority: 'urgent' });
    const b = await first.postIssue({ title: 'Durable default' });
    await first.patchIssue(b.body.id, { priority: 'low' });
    await first.stop();

    const raw = JSON.parse(await readFile(first.storePath, 'utf8'));
    assert.deepEqual(
      raw.issues.map((issue) => issue.priority),
      ['urgent', 'low'],
      'the on-disk file carries priority in creation order',
    );
    for (const issue of raw.issues) {
      assert.deepEqual(
        Object.keys(issue).sort(),
        ['createdAt', 'description', 'id', 'priority', 'status', 'title', 'updatedAt'],
      );
    }

    const second = await bootTracker(dataDir);
    try {
      const after = await second.list();
      assert.deepEqual(
        after.body.items.map((issue) => issue.priority),
        ['low', 'urgent'],
        'a new process serves the same priorities newest first',
      );
      const appended = await second.postIssue({ title: 'After restart', priority: 'high' });
      assert.equal(appended.body.priority, 'high');
    } finally {
      await second.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('concurrent priority patches serialize; no torn or lost state', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue({ title: 'Contested', priority: 'normal' });
    const id = created.body.id;

    const patches = await Promise.all(
      Array.from({ length: 20 }, (_, index) => tracker.patchIssue(id, { priority: PRIORITIES[index % 4] })),
    );
    assert.ok(patches.every((response) => response.status === 200), 'every serialized patch commits');

    const listed = await tracker.list();
    assert.equal(listed.body.items.length, 1);
    assert.ok(
      PRIORITIES.includes(listed.body.items[0].priority),
      'the last committed priority is one of the four values: ' + listed.body.items[0].priority,
    );

    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.equal(stored.issues.length, 1);
    assert.equal(stored.issues[0].priority, listed.body.items[0].priority, 'disk matches the served value');
    assert.deepEqual(await readdir(tracker.dataDir), ['issues.json'], 'no temp files left behind');
  });
});

process.on('exit', () => {
  resetApiStore();
  delete process.env.DATA_DIR;
});
