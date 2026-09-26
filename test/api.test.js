// Regression tests for TEST-API (specs/issue-tracker.md): API behavior, input
// validation, durable persistence across restart, concurrent writes, corrupt
// stores and reproducible write failures. Every test uses an isolated temp
// DATA_DIR; no live data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { resetApiStore } from '../src/api.js';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BODY_LIMIT = 16 * 1024;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function bootTracker(dataDir) {
  process.env.DATA_DIR = dataDir;
  resetApiStore();
  const server = createServer();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + server.address().port;
      const tracker = {
        dataDir,
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
          return { status: response.status, body, text, headers: response.headers };
        },
        async postIssue(title, description) {
          const payload = description === undefined ? { title } : { title, description };
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
  const dataDir = await mkdtemp(join(tmpdir(), 'issue-api-'));
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

test('health endpoint and empty issue list', async () => {
  await withTracker(async (tracker) => {
    const health = await tracker.request('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    const list = await tracker.list();
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { items: [] });
  });
});

test('create returns full issue with defaults, trimmed title and ISO UTC timestamps', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('  Fix login flow  ', 'Session expires too early.');
    assert.equal(created.status, 201);
    const issue = created.body;
    assert.match(issue.id, UUID);
    assert.equal(issue.title, 'Fix login flow');
    assert.equal(issue.description, 'Session expires too early.');
    assert.equal(issue.status, 'open');
    assert.match(issue.createdAt, ISO_UTC);
    assert.match(issue.updatedAt, ISO_UTC);
    assert.equal(issue.createdAt, issue.updatedAt);
    assert.deepEqual(Object.keys(issue).sort(), ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt']);
    const listed = await tracker.list();
    assert.equal(listed.body.items.length, 1);
    assert.deepEqual(listed.body.items[0], issue);
  });
});

test('list returns newest first and supports status and case-insensitive q filters', async () => {
  await withTracker(async (tracker) => {
    const first = await tracker.postIssue('First issue', 'alpha note');
    await tracker.postIssue('Second ISSUE', 'nothing here');
    await tracker.patchIssue(first.body.id, { status: 'done' });
    const third = await tracker.postIssue('third', 'BETA note');

    const all = await tracker.list();
    assert.deepEqual(
      all.body.items.map((issue) => issue.title),
      ['third', 'Second ISSUE', 'First issue'],
    );

    const done = await tracker.list('?status=done');
    assert.deepEqual(done.body.items.map((issue) => issue.title), ['First issue']);

    const byTitle = await tracker.list('?q=second');
    assert.deepEqual(byTitle.body.items.map((issue) => issue.title), ['Second ISSUE']);

    const byDescription = await tracker.list('?q=alpha');
    assert.deepEqual(byDescription.body.items.map((issue) => issue.title), ['First issue']);

    const combined = await tracker.list('?status=done&q=alpha');
    assert.equal(combined.body.items.length, 1);

    const invalid = await tracker.list('?status=closed');
    assert.equal(invalid.status, 400);
    assertErrorBody(invalid.body);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

    assert.equal(third.status, 201);
  });
});

test('create rejects invalid fields, unknown fields and invalid JSON', async () => {
  await withTracker(async (tracker) => {
    const cases = [
      [{}, 'missing title'],
      [{ title: 42 }, 'non-string title'],
      [{ title: '   ' }, 'whitespace-only title'],
      [{ title: 'a'.repeat(121) }, 'title over 120 characters'],
      [{ title: 'ok', description: 7 }, 'non-string description'],
      [{ title: 'ok', description: 'd'.repeat(4001) }, 'description over 4000 characters'],
      [{ title: 'ok', status: 'open' }, 'status not accepted on create'],
      [{ title: 'ok', priority: 'high' }, 'unknown field'],
    ];
    for (const [payload, label] of cases) {
      const response = await tracker.request('/api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400, label);
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
    }

    const boundaries = await tracker.postIssue('t'.repeat(120), 'd'.repeat(4000));
    assert.equal(boundaries.status, 201);
    assert.equal(boundaries.body.title.length, 120);
    assert.equal(boundaries.body.description.length, 4000);

    const invalidJson = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"title": broken',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.code, 'INVALID_JSON');

    for (const raw of ['[]', '"text"', 'null', '']) {
      const response = await tracker.request('/api/issues', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      assert.equal(response.status, 400, 'body: ' + raw);
      assertErrorBody(response.body);
    }

    const list = await tracker.list();
    assert.equal(list.body.items.length, 1, 'only the boundary issue was accepted');
  });
});

test('request bodies above 16 KiB are rejected with 413, at the limit they are parsed', async () => {
  await withTracker(async (tracker) => {
    const prefix = '{"title":"cap check","description":"';
    const suffix = '"}';
    const pad = BODY_LIMIT - prefix.length - suffix.length;
    const atLimit = prefix + 'a'.repeat(pad) + suffix;
    assert.equal(Buffer.byteLength(atLimit), BODY_LIMIT);
    const boundary = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: atLimit,
    });
    assert.equal(boundary.status, 400, 'body at the cap is parsed, then fails field validation');
    assert.equal(boundary.body.error.code, 'VALIDATION_ERROR');

    const over = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: atLimit + ' ',
    });
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, 'PAYLOAD_TOO_LARGE');

    const created = await tracker.postIssue('base');
    const patchOver = await tracker.patchIssue(created.body.id, { description: 'x'.repeat(BODY_LIMIT) });
    assert.equal(patchOver.status, 413);
    assert.equal(patchOver.body.error.code, 'PAYLOAD_TOO_LARGE');
  });
});

test('patch updates subsets, rejects invalid input, 404s unknown issues', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('Original title', 'Original description');
    const id = created.body.id;
    await new Promise((resolve) => setTimeout(resolve, 10));

    const statusOnly = await tracker.patchIssue(id, { status: 'in_progress' });
    assert.equal(statusOnly.status, 200);
    assert.equal(statusOnly.body.title, 'Original title');
    assert.equal(statusOnly.body.status, 'in_progress');
    assert.equal(statusOnly.body.updatedAt > statusOnly.body.createdAt, true, 'updatedAt advances');

    const titleOnly = await tracker.patchIssue(id, { title: '  Padded title  ' });
    assert.equal(titleOnly.body.title, 'Padded title');
    assert.equal(titleOnly.body.description, 'Original description');

    const several = await tracker.patchIssue(id, { description: 'New text', status: 'done' });
    assert.equal(several.body.description, 'New text');
    assert.equal(several.body.status, 'done');
    assert.equal(several.body.id, id);
    assert.equal(several.body.createdAt, created.body.createdAt, 'createdAt never changes');

    const cases = [
      [{}, 'empty patch'],
      [{ unknown: 1 }, 'unknown field'],
      [{ status: 'closed' }, 'invalid status'],
      [{ status: 'OPEN' }, 'status is case sensitive'],
      [{ title: '' }, 'empty title'],
      [{ title: 'x'.repeat(121) }, 'title over 120 characters'],
      [{ description: null }, 'null description'],
    ];
    for (const [payload, label] of cases) {
      const response = await tracker.patchIssue(id, payload);
      assert.equal(response.status, 400, label);
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', label);
    }

    const invalidJson = await tracker.request('/api/issues/' + id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal(invalidJson.body.error.code, 'INVALID_JSON');

    const missing = await tracker.patchIssue('00000000-0000-4000-8000-000000000000', { title: 'Nope' });
    assert.equal(missing.status, 404);
    assertErrorBody(missing.body);

    const after = await tracker.patchIssue(id, { title: 'Final title' });
    assert.equal(after.body.title, 'Final title');
    assert.equal(after.body.status, 'done', 'failed patches above changed nothing');
  });
});

test('non-string and hostile-toString field values get 400 and leave the record unchanged', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('Stable title', 'Stable description');
    const before = (await tracker.list()).body.items[0];

    // status must never be string-coerced: {"toString": null} used to escape as a 500
    const hostileStatuses = [null, 1, true, ['open'], {}, { toString: null }, { valueOf: null }];
    for (const status of hostileStatuses) {
      const response = await tracker.patchIssue(created.body.id, { status });
      assert.equal(response.status, 400, 'status: ' + JSON.stringify(status));
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', 'status: ' + JSON.stringify(status));
      assert.equal(response.body.error.message.includes('status'), true);
    }

    const otherHostileFields = [
      { title: { toString: null } },
      { title: ['not', 'a', 'title'] },
      { title: 3.14 },
      { description: { toString: null } },
      { description: 42 },
    ];
    for (const payload of otherHostileFields) {
      const response = await tracker.patchIssue(created.body.id, payload);
      assert.equal(response.status, 400, JSON.stringify(payload));
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'VALIDATION_ERROR', JSON.stringify(payload));
    }

    const badCreate = await tracker.request('/api/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: { toString: null } }),
    });
    assert.equal(badCreate.status, 400);
    assert.equal(badCreate.body.error.code, 'VALIDATION_ERROR');

    const after = await tracker.list();
    assert.equal(after.body.items.length, 1);
    assert.deepEqual(after.body.items[0], before, 'rejected patches changed nothing');

    const good = await tracker.patchIssue(created.body.id, { status: 'done' });
    assert.equal(good.status, 200);
    assert.equal(good.body.status, 'done');
  });
});

test('unsupported methods get 405 with Allow, unknown API paths 404', async () => {
  await withTracker(async (tracker) => {
    const created = await tracker.postIssue('For methods');
    const cases = [
      ['/api/issues', 'DELETE'],
      ['/api/issues', 'PUT'],
      ['/api/issues/' + created.body.id, 'GET'],
      ['/api/issues/' + created.body.id, 'POST'],
      ['/api/issues/' + created.body.id, 'DELETE'],
    ];
    for (const [path, method] of cases) {
      const response = await tracker.request(path, { method });
      assert.equal(response.status, 405, method + ' ' + path);
      assertErrorBody(response.body);
      assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
      assert.ok(response.headers.get('allow'), 'Allow header present');
    }

    const unknown = await tracker.request('/api/nothing');
    assert.equal(unknown.status, 404);
    assertErrorBody(unknown.body);
  });
});

test('accepted changes survive a restart and preserve order and fields', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'issue-api-'));
  try {
    const first = await bootTracker(dataDir);
    const a = await first.postIssue('Keep me', 'Persistent description');
    await first.patchIssue(a.body.id, { status: 'in_progress' });
    await first.postIssue('Second item');
    const before = await first.list();
    await first.stop();

    const second = await bootTracker(dataDir);
    try {
      const after = await second.list();
      assert.equal(after.status, 200);
      assert.deepEqual(after.body, before.body, 'same items, same order after reload');
      const reloaded = after.body.items.find((issue) => issue.id === a.body.id);
      assert.equal(reloaded.status, 'in_progress');
      assert.equal(reloaded.updatedAt, before.body.items.find((issue) => issue.id === a.body.id).updatedAt);

      const appended = await second.postIssue('After restart');
      assert.equal(appended.status, 201);
      const final = await second.list();
      assert.deepEqual(
        final.body.items.map((issue) => issue.title),
        ['After restart', 'Second item', 'Keep me'],
      );
    } finally {
      await second.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a corrupt store fails visibly and is never overwritten', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'issue-api-'));
  const storePath = join(dataDir, 'issues.json');
  const record = (overrides = {}) =>
    JSON.stringify({
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Stored item',
      description: 'kept text',
      status: 'open',
      createdAt: '2026-02-28T12:34:56Z',
      updatedAt: '2026-02-28T12:34:56.000Z',
      ...overrides,
    });
  const corruptFiles = [
    ['truncated json', '{"issues": [{"id": "x"'],
    ['wrong top-level shape', '{"items": []}'],
    ['unexpected top-level key', '{"issues": [], "version": 1}'],
    ['record is not an object', '{"issues": ["open"]}'],
    ['id is not a uuid', `{"issues": [${record({ id: 'not-a-uuid' })}]}`],
    ['duplicate record ids', `{"issues": [${record()}, ${record({ title: 'Second copy' })}]}`],
    ['blank title', `{"issues": [${record({ title: '' })}]}`],
    ['untrimmed title', `{"issues": [${record({ title: ' padded ' })}]}`],
    ['description over 4000 characters', `{"issues": [${record({ description: 'd'.repeat(4001) })}]}`],
    ['status outside the enum', `{"issues": [${record({ status: 'closed' })}]}`],
    ['non-utc timestamp form', `{"issues": [${record({ createdAt: '2026-02-28T12:34:56+00:00' })}]}`],
    ['impossible date without milliseconds', `{"issues": [${record({ createdAt: '2026-02-30T00:00:00Z' })}]}`],
    ['impossible date with milliseconds', `{"issues": [${record({ updatedAt: '2026-02-30T00:00:00.000Z' })}]}`],
    ['impossible time', `{"issues": [${record({ createdAt: '2026-02-28T25:00:00Z' })}]}`],
    ['relative timestamp text', `{"issues": [${record({ createdAt: 'yesterday' })}]}`],
    ['unknown record field', `{"issues": [${record({ priority: 'high' })}]}`],
    ['missing record field', '{"issues": [{"id": "11111111-1111-4111-8111-111111111111", "title": "Stored item", "description": "kept text", "status": "open", "createdAt": "2026-02-28T12:34:56Z"}]}'],
  ];
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.join(' '));
  try {
    for (const [label, content] of corruptFiles) {
      await writeFile(storePath, content, 'utf8');
      const tracker = await bootTracker(dataDir);
      try {
        const list = await tracker.list();
        assert.equal(list.status, 500, label);
        assertErrorBody(list.body);
        assert.equal(list.body.error.code, 'STORAGE_ERROR', label);

        const created = await tracker.postIssue('Should not persist');
        assert.equal(created.status, 500, label);
        assert.equal(created.body.error.code, 'STORAGE_ERROR', label);

        const patched = await tracker.patchIssue('22222222-2222-4222-8222-222222222222', { title: 'No luck' });
        assert.equal(patched.status, 500, label);
        assert.equal(patched.body.error.code, 'STORAGE_ERROR', label);

        assert.equal(await readFile(storePath, 'utf8'), content, 'corrupt bytes untouched: ' + label);
        const files = await readdir(dataDir);
        assert.deepEqual(files, ['issues.json'], 'no temp files left behind: ' + label);
      } finally {
        await tracker.stop();
      }
    }
  } finally {
    console.error = originalConsoleError;
    await rm(dataDir, { recursive: true, force: true });
  }
  assert.ok(
    loggedErrors.some((line) => line.includes('Corrupt issue store')),
    'server logs the corruption visibly',
  );
});

test('a store file with valid legacy records stays fully usable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'issue-api-'));
  const storePath = join(dataDir, 'issues.json');
  try {
    // Hand-written valid store: mixed timestamp precision, empty description,
    // a leap-day instant and a done issue.
    await writeFile(
      storePath,
      JSON.stringify(
        {
          issues: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              title: 'Legacy done issue',
              description: 'old text',
              status: 'done',
              createdAt: '2024-02-29T08:00:00Z',
              updatedAt: '2024-02-29T09:30:00Z',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'Legacy active issue',
              description: '',
              status: 'in_progress',
              createdAt: '2026-02-28T12:34:56Z',
              updatedAt: '2026-02-28T12:34:56.250Z',
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
    const tracker = await bootTracker(dataDir);
    try {
      const list = await tracker.list();
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.items.map((issue) => issue.title),
        ['Legacy active issue', 'Legacy done issue'],
      );

      const patched = await tracker.patchIssue('11111111-1111-4111-8111-111111111111', { title: 'Renamed legacy' });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.title, 'Renamed legacy');

      const created = await tracker.postIssue('Fresh issue');
      assert.equal(created.status, 201);

      const final = await tracker.list();
      assert.deepEqual(
        final.body.items.map((issue) => issue.title),
        ['Fresh issue', 'Legacy active issue', 'Renamed legacy'],
      );
      const stored = JSON.parse(await readFile(storePath, 'utf8'));
      assert.equal(stored.issues.length, 3);
      assert.deepEqual(
        Object.keys(stored.issues[2]).sort(),
        ['createdAt', 'description', 'id', 'status', 'title', 'updatedAt'],
      );
    } finally {
      await tracker.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed writes stay uncommitted and are never smuggled into later writes', { skip: isRoot }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'issue-api-'));
  try {
    const tracker = await bootTracker(dataDir);
    const good = await tracker.postIssue('Committed issue', 'before failure');
    assert.equal(good.status, 201);
    const fileBefore = await readFile(tracker.storePath, 'utf8');

    await chmod(dataDir, 0o555);
    try {
      const failed = await tracker.postIssue('Must not persist', 'write should fail');
      assert.equal(failed.status, 500);
      assert.equal(failed.body.error.code, 'STORAGE_ERROR');

      const failedPatch = await tracker.patchIssue(good.body.id, { title: 'Must not persist either' });
      assert.equal(failedPatch.status, 500);
      assert.equal(failedPatch.body.error.code, 'STORAGE_ERROR');

      const list = await tracker.list();
      assert.equal(list.status, 200);
      assert.deepEqual(
        list.body.items.map((issue) => issue.title),
        ['Committed issue'],
        'readers never see the failed write',
      );
      assert.equal(await readFile(tracker.storePath, 'utf8'), fileBefore, 'store file unchanged by failed writes');
      const files = await readdir(dataDir);
      assert.deepEqual(files, ['issues.json'], 'failed write leaves no temp file');
    } finally {
      await chmod(dataDir, 0o755);
    }

    const recovered = await tracker.postIssue('After recovery', 'committed later');
    assert.equal(recovered.status, 201);
    const list = await tracker.list();
    assert.deepEqual(
      list.body.items.map((issue) => issue.title),
      ['After recovery', 'Committed issue'],
      'the failed write is not carried into the next successful write',
    );
    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.deepEqual(
      stored.issues.map((issue) => issue.title),
      ['Committed issue', 'After recovery'],
    );
    await tracker.stop();
  } finally {
    await chmod(dataDir, 0o755).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('concurrent first touches share one load; no item is lost', async () => {
  await withTracker(async (tracker) => {
    const results = await Promise.all([
      tracker.list(),
      tracker.postIssue('Concurrent one'),
      tracker.postIssue('Concurrent two'),
      tracker.list(),
    ]);
    assert.equal(results[0].status, 200);
    assert.equal(results[1].status, 201);
    assert.equal(results[2].status, 201);
    assert.equal(results[3].status, 200);
    for (const list of [results[0], results[3]]) {
      assert.ok(Array.isArray(list.body.items));
      assert.ok(list.body.items.length <= 2, 'in-flight list sees only committed items');
    }

    const followUp = await tracker.postIssue('Concurrent three');
    assert.equal(followUp.status, 201);
    const final = await tracker.list();
    assert.deepEqual(
      final.body.items.map((issue) => issue.title),
      ['Concurrent three', 'Concurrent two', 'Concurrent one'],
    );
    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.equal(stored.issues.length, 3, 'every concurrent create reached the store file');
  });
});

test('parallel creates and updates are serialized without lost writes', async () => {
  await withTracker(async (tracker) => {
    const creates = await Promise.all(
      Array.from({ length: 30 }, (_, index) => tracker.postIssue('Bulk ' + index)),
    );
    assert.ok(creates.every((response) => response.status === 201));
    const ids = new Set(creates.map((response) => response.body.id));
    assert.equal(ids.size, 30, 'unique server-generated ids');

    const listed = await tracker.list();
    assert.equal(listed.body.items.length, 30);
    const stored = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.equal(stored.issues.length, 30, 'no create lost on disk');

    const target = creates[0].body.id;
    const patches = await Promise.all(
      Array.from({ length: 20 }, (_, index) => tracker.patchIssue(target, { description: 'patch ' + index })),
    );
    assert.ok(patches.every((response) => response.status === 200));

    const final = await tracker.list();
    assert.equal(final.body.items.length, 30, 'other issues intact');
    const updated = final.body.items.find((issue) => issue.id === target);
    assert.ok(
      updated.description.startsWith('patch '),
      'last committed patch wins: ' + updated.description,
    );
    const storedFinal = JSON.parse(await readFile(tracker.storePath, 'utf8'));
    assert.equal(storedFinal.issues.length, 30);
    const files = await readdir(tracker.dataDir);
    assert.deepEqual(files, ['issues.json'], 'no temp files left behind');
  });
});

process.on('exit', () => {
  resetApiStore();
  delete process.env.DATA_DIR;
});
