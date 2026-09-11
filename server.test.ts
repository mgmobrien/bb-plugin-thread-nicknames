import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';

test('new threads: delayed titles, sequential numbers, forks, reloads, and old-thread exclusion', async () => {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const callbacks: Array<{ event: string; callback: (event: any) => void }> = [];
  let host = createFakePluginHost({ pluginId: 'thread-nicknames', sdk: {
    subscribe: args => { callbacks.push(args); return () => {}; },
    threads: {
      get: async ({ threadId }) => { const t = threads.get(threadId); if (!t) throw Error('missing'); return t; },
      list: async () => [...threads.values()],
      update: async ({ threadId, title }) => {
        const t = threads.get(threadId)!;
        t.title = title!;
        return t;
      },
    },
  }});
  const add = (id: string, title: string | null, createdAt = Date.now() + 1000) => {
    const t = makeThreadResponse({ id, title, titleFallback: 'A longer request for a thread title', createdAt });
    threads.set(id, t); return t;
  };
  await plugin(host.bb);
  try {
    const first = add('thr_abcd111', null);
    await host.harness.behavior.emitThreadEvent('thread.created', { thread: first });
    assert.equal(first.title, null, 'must not preempt title generator');
    first.title = 'Fix login';
    callbacks.find(c => c.event === 'thread:changed')!.callback({ id: first.id, changes: ['title-changed'] });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(first.title, '@1 Fix login');
    const second = add('thr_abcd222', 'Other task');
    await host.harness.behavior.emitThreadEvent('thread.active', { thread: second });
    assert.equal(second.title, '@2 Other task');
    await host.harness.behavior.emitThreadEvent('thread.active', { thread: second });
    assert.equal(second.title, '@2 Other task', 'no repeated prefix');
    const old = add('thr_old123', 'Old task', 1);
    await host.harness.behavior.emitThreadEvent('thread.active', { thread: old });
    assert.equal(old.title, 'Old task');
    const fork = add('thr_fork123', first.title);
    await host.harness.behavior.emitThreadEvent('thread.created', { thread: fork });
    assert.equal(fork.title, '@3 Fix login');
    const failed = add('thr_fail123', null);
    await host.harness.behavior.emitThreadEvent('thread.idle', { thread: failed, lastAssistantText: null });
    assert.equal(failed.title, '@4 A longer request for a thread title');
    host = await host.harness.lifecycle.reload(plugin);
    second.title = 'Updated task';
    await host.harness.behavior.emitThreadEvent('thread.active', { thread: second });
    assert.equal(second.title, '@2 Updated task', 'code survives reload');
  } finally { await host.harness.lifecycle.dispose(); }
});

test('migrates old codes once, reserves deleted numbers, and expands after 999', async () => {
  const thread = makeThreadResponse({ id: 'thr_legacy', title: '[FINB] Existing task', createdAt: 1 });
  let host = createFakePluginHost({ pluginId: 'thread-nicknames', sdk: {
    subscribe: () => () => {},
    threads: {
      get: async () => thread,
      list: async () => [thread],
      update: async ({ title }) => { thread.title = title!; return thread; },
    },
  }});
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [
    'CREATE TABLE nicknames (thread_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE)',
    'CREATE TABLE config (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  ]);
  db.prepare('INSERT INTO nicknames VALUES (?, ?)').run('thr_legacy', 'FINB');
  await plugin(host.bb);
  try {
    await host.harness.behavior.emitThreadEvent('thread.active', { thread });
    assert.equal(thread.title, '@1 Existing task');
    host = await host.harness.lifecycle.reload(plugin);
    thread.title = '[001] Existing task';
    await host.harness.behavior.emitThreadEvent('thread.active', { thread });
    assert.equal(thread.title, '@1 Existing task');
    const currentDb = host.bb.storage.database();
    currentDb.prepare('INSERT INTO thread_numbers (number, thread_id) VALUES (?, ?)').run(999, 'thr_deleted');
    thread.id = 'thr_new'; thread.createdAt = Date.now() + 1000; thread.title = 'New task';
    await host.harness.behavior.emitThreadEvent('thread.created', { thread });
    assert.equal(thread.title, '@1000 New task');
    assert.equal((currentDb.prepare('SELECT number FROM thread_numbers WHERE thread_id = ?').get('thr_deleted') as {number:number}).number, 999);
  } finally { await host.harness.lifecycle.dispose(); }
});
