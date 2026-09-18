import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const rpcContract = defineRpcContract({
  list: {
    input: z.object({ offset: z.number().int().min(0).max(1000000) }),
    output: z.object({ rows: z.array(z.object({ threadId: z.string(), code: z.string(), title: z.string(), available: z.boolean() })), hasMore: z.boolean() }),
  },
});

type Thread = Awaited<ReturnType<BbPluginApi['sdk']['threads']['get']>>;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    'CREATE TABLE nicknames (thread_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE)',
    'CREATE TABLE config (key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
    'CREATE TABLE thread_numbers (number INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL UNIQUE)',
    'INSERT INTO thread_numbers (thread_id) SELECT thread_id FROM nicknames ORDER BY rowid',
  ]);
  db.prepare('INSERT OR IGNORE INTO config VALUES (?, ?)').run('enabled_at', Date.now());
  const enabledAt = (db.prepare('SELECT value FROM config WHERE key = ?').get('enabled_at') as { value: number }).value;
  const lookup = db.prepare("SELECT CAST(number AS TEXT) AS code FROM thread_numbers WHERE thread_id = ?");
  // Legacy codes remain recognizable while old titles and forks are converted.
  const owner = db.prepare("SELECT thread_id FROM nicknames WHERE code = ? UNION ALL SELECT thread_id FROM thread_numbers WHERE printf('%03d', number) = ? OR CAST(number AS TEXT) = ? LIMIT 1");
  const insert = db.prepare('INSERT INTO thread_numbers (thread_id) VALUES (?)');
  const allocate = db.transaction((threadId: string) => {
    const existing = lookup.get(threadId) as { code: string } | undefined;
    if (existing) return existing.code;
    const result = insert.run(threadId);
    return String(result.lastInsertRowid);
  });
  let disposed = false;
  const jobs = new Map<string, Promise<void>>();

  async function apply(threadId: string, allowFallback = false, explicit = false) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (disposed || thread.deletedAt !== null) return;
    if (!explicit && thread.createdAt < enabledAt && !lookup.get(threadId)) return;
    const code = allocate(threadId);
    const title = thread.title?.trim();
    // Never populate an empty title before bb's metadata generator has finished.
    const body = title || (allowFallback ? thread.titleFallback?.trim() : null);
    if (!body) return;
    const prefix = `@${code}`;
    if (body === prefix || body.startsWith(`${prefix} `)) return;
    // Forks can inherit another thread's prefix; replace only plugin-owned codes.
    const inherited = /^(?:\[([A-Z0-9]+)\]|@(\d+))\s+/.exec(body);
    const previousCode = inherited?.[1] ?? inherited?.[2];
    const clean = inherited && previousCode && owner.get(previousCode, previousCode, previousCode) ? body.slice(inherited[0].length) : body;
    if (disposed) return;
    await bb.sdk.threads.update({ threadId, title: `${prefix} ${clean}` });
  }
  function enqueue(id: string, fallback = false, explicit = false) {
    const previous = jobs.get(id) ?? Promise.resolve();
    const next = previous.then(() => disposed ? undefined : apply(id, fallback, explicit))
      .catch((error: unknown) => bb.log.warn(`Could not prefix ${id}: ${String(error)}`));
    jobs.set(id, next);
    void next.then(() => { if (jobs.get(id) === next) jobs.delete(id); });
    return next;
  }
  function observe(thread: Thread, finished = false) {
    const short = (thread.titleFallback ?? '').trim().split(/\s+/).length < 5;
    return enqueue(thread.id, finished || short);
  }
  bb.events.on('thread.created', ({ thread }) => enqueue(thread.id));
  bb.events.on('thread.active', ({ thread }) => observe(thread));
  bb.events.on('thread.idle', ({ thread }) => observe(thread, true));
  bb.events.on('thread.failed', ({ thread }) => observe(thread, true));
  const unsubscribe = bb.sdk.subscribe({
    event: 'thread:changed',
    callback(event) {
      if (event.id && event.changes.some(c => c === 'title-changed' || c === 'thread-created')) {
        void enqueue(event.id);
      }
    },
  });
  async function reconcile() {
    const pending = new Map<string, boolean>();
    for (const archived of [false, true]) {
      for (let offset = 0; !disposed; offset += 100) {
        const page = await bb.sdk.threads.list({ limit: 100, offset, includeHidden: true, archived });
        for (const thread of page) {
          if (thread.createdAt >= enabledAt || lookup.get(thread.id)) {
            pending.set(thread.id, thread.status === 'idle' || thread.status === 'error');
          }
        }
        if (page.length < 100) break;
      }
    }
    // Read all pages before renaming: a title update can change list ordering.
    for (const [id, fallback] of pending) await enqueue(id, fallback);
  }
  const reconnect = bb.sdk.subscribe({ event: 'realtime:connection', callback(event) {
    if (event.state === 'connected' && event.reconnected) void reconcile().catch(e => bb.log.warn(String(e)));
  }});
  bb.background.service('reconcile', { async start() { await reconcile(); } });
  bb.rpc.register(rpcContract, {
    async list({ offset }) {
      const records = db.prepare("SELECT thread_id, '@' || number AS code FROM thread_numbers ORDER BY number LIMIT 101 OFFSET ?").all(offset) as { thread_id: string; code: string }[];
      const rows = await Promise.all(records.slice(0, 100).map(async row => {
        try {
          const thread = await bb.sdk.threads.get({ threadId: row.thread_id });
          return { threadId: row.thread_id, code: row.code, title: thread.title ?? thread.titleFallback ?? 'Untitled', available: thread.deletedAt === null };
        } catch {
          return { threadId: row.thread_id, code: row.code, title: 'Thread details unavailable', available: false };
        }
      }));
      return { rows, hasMore: records.length > 100 };
    },
  });
  bb.cli.register({
    name: 'thread-nicknames', summary: 'Inspect automatic thread nicknames or prefix a specific thread.',
    async run(argv, ctx) {
      if (argv[0] === 'apply') {
        const id = argv[1] ?? ctx.threadId;
        if (!id) return { exitCode: 1, stderr: 'A thread ID is required.\n' };
        await enqueue(id, false, true);
        const thread = await bb.sdk.threads.get({ threadId: id });
        return { exitCode: 0, stdout: `${thread.title ?? '(waiting for title)'}\n` };
      }
      return { exitCode: 0, stdout: JSON.stringify({ enabledAt, nicknames: db.prepare("SELECT thread_id, '@' || number AS code FROM thread_numbers ORDER BY number LIMIT 100").all() }, null, 2) + '\n' };
    },
  });
  bb.onDispose(async () => {
    disposed = true;
    unsubscribe();
    reconnect();
    await Promise.all(jobs.values());
  });
}
