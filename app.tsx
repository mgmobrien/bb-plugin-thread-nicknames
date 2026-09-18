import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import './app.css';

type Row = { threadId: string; code: string; title: string; available: boolean };
function Nicknames() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<Row[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const id = ++request.current;
    setBusy(true); setError(null);
    rpc.call('list', { offset }).then(result => {
      if (id !== request.current) return;
      setRows(result.rows); setMore(result.hasMore); setBusy(false);
    }, () => { if (id === request.current) { setError('Could not load numbered threads. Try again.'); setBusy(false); } });
  }, [rpc, offset]);
  useEffect(() => { refresh(); return () => { request.current++; }; }, [refresh]);
  return <section data-nicknames-page>
    <p>Numbers belong to threads, wherever you open them. Select a thread to open it.</p>
    <div data-nicknames-controls><button onClick={refresh} disabled={busy}>Refresh</button><span>{busy ? 'Loading…' : `${offset + (rows.length ? 1 : 0)}–${offset + rows.length}`}</span></div>
    {error ? <p role="alert">{error}</p> : !busy && rows.length === 0 ? <p>No numbered threads yet. New threads receive numbers automatically.</p> : <ul aria-label="Numbered threads">{rows.map(row => <li key={row.threadId}><button disabled={busy || !row.available} onClick={() => navigate.toThread(row.threadId)}><strong>{row.code}</strong><span>{row.title.startsWith(row.code + ' ') ? row.title.slice(row.code.length + 1) : row.title}</span>{!row.available ? <small>Unavailable</small> : null}</button></li>)}</ul>}
    <div data-nicknames-controls><button disabled={busy || offset === 0} onClick={() => setOffset(n => Math.max(0, n - 100))}>Previous</button><button disabled={busy || !more} onClick={() => setOffset(n => n + 100)}>Next</button></div>
    <p data-nicknames-note>Disabling this plugin stops future numbering. Existing title prefixes and saved numbers remain.</p>
  </section>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: "numbers", title: "Numbered threads", component: Nicknames });
  app.slots.navPanel({ id: 'numbers', title: 'Thread nicknames', icon: 'ListTodo', path: 'numbers', component: Nicknames });
});
