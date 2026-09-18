# Thread nicknames for bb

Give bb threads persistent, sequential numbers in their titles: `@27 Fix login`.

These numbers belong to **threads**, not pane positions. Moving a thread between panes does not change its number.

## Behavior

- New threads receive a unique number, retained across plugin reloads and title changes.
- Empty titles are left alone while bb generates metadata. The plugin can use the fallback title when the thread finishes or the fallback is short.
- Forks receive their own number instead of keeping the parent’s plugin-owned prefix.
- Threads older than the first activation are left alone unless already numbered or explicitly requested through the CLI.
- Deleted numbers are not reused; numbering continues beyond 999.
- The plugin reconciles eligible threads on startup and reconnect, including archived and hidden threads.

## Install from source

Requires bb 0.42+ and a recent Node version supporting `--experimental-strip-types` (Node 22.6+). Developed against bb 0.42.1 and plugin SDK 0.4.47.

```sh
git clone https://github.com/mgmobrien/bb-plugin-thread-nicknames.git
cd bb-plugin-thread-nicknames
npm ci
npm run typecheck
npm test
npm run build
bb plugin install .
```

Keep the source directory at a durable location. The plugin’s package name, `bb-plugin-thread-nicknames`, determines its bb identity; renaming it would attach to a different plugin data directory.

## Sidebar and Settings

Open **Thread nicknames** from the sidebar or Settings → Plugins → Thread nicknames to browse saved numbers, 100 per page. Select a row to open its thread. Use **Refresh**, **Previous** and **Next** to navigate; unavailable threads are marked and cannot be opened. The list reads existing numbers without allocating new ones.

## CLI

Inspect the first 100 recorded thread numbers:

```sh
bb thread-nicknames
```

Apply a number to the current thread, or explicitly name a thread ID:

```sh
bb thread-nicknames apply
bb thread-nicknames apply YOUR_THREAD_ID
```

The explicit command also permits numbering a thread created before activation. It may wait for a title to become available. Background update failures are logged by the plugin; the command’s printed title is not a separate write-success guarantee.

## Data and side effects

This plugin **changes actual thread titles**, rather than rendering a visual-only badge. Disabling it stops future updates but does not remove prefixes already written.

The bb-managed plugin database stores thread-ID/number mappings, the first-activation time and legacy nickname migration data. This repository includes schema and synthetic tests only—no live database or mappings. Preserve the plugin’s data if you want existing numbering to survive a reinstall. Migration statements are deliberately retained byte-for-byte for compatibility with existing installations.

## Tests

`server.test.ts` uses the SDK fake host and synthetic thread IDs. It covers delayed titles, sequential allocation, inherited prefixes, reloads, old-thread exclusion, legacy migration, deleted-number reservation and numbering past 999. It does not access a running bb instance.

Built with **MattBot — Matt’s AI assistant (GPT-6 Astra today)**.
