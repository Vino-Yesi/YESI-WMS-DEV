import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Link2, Plus, Pencil, Trash2, ExternalLink, Save, X, CalendarDays, Package,
} from 'lucide-react';
import { db, logAction, type GSheetEntry } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function emptyForm(day: string): Omit<GSheetEntry, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: '',
    url: '',
    day,
    expectedOrders: 0,
    expectedQty: 0,
    packedOrders: 0,
    packedQty: 0,
    note: '',
  };
}

export default function GSheetHub() {
  const { user } = useAuth();
  const operator = user?.displayName || user?.username || 'Operator';
  const [day, setDay] = useState(todayISO());
  const [rows, setRows] = useState<GSheetEntry[]>([]);
  const [form, setForm] = useState(emptyForm(todayISO()));
  const [editingId, setEditingId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const all = await db.gSheetEntries.where('day').equals(day).toArray();
    all.sort((a, b) => a.name.localeCompare(b.name));
    setRows(all);
  }, [day]);

  useEffect(() => {
    load();
    setForm((f) => ({ ...f, day }));
  }, [load, day]);

  const totals = useMemo(() => {
    return rows.reduce(
      (acc, r) => {
        acc.expectedOrders += r.expectedOrders || 0;
        acc.expectedQty += r.expectedQty || 0;
        acc.packedOrders += r.packedOrders || 0;
        acc.packedQty += r.packedQty || 0;
        return acc;
      },
      { expectedOrders: 0, expectedQty: 0, packedOrders: 0, packedQty: 0 }
    );
  }, [rows]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm(day));
  };

  const startEdit = (r: GSheetEntry) => {
    if (r.id == null) return;
    setEditingId(r.id);
    setForm({
      name: r.name,
      url: r.url,
      day: r.day,
      expectedOrders: r.expectedOrders,
      expectedQty: r.expectedQty,
      packedOrders: r.packedOrders,
      packedQty: r.packedQty,
      note: r.note || '',
      operator: r.operator,
    });
  };

  const save = async () => {
    const name = form.name.trim();
    const url = form.url.trim();
    if (!name || !url) {
      setMessage('Name and Google Sheet link are required.');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      setMessage('URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const now = new Date().toISOString();
      const payload: GSheetEntry = {
        name,
        url,
        day: form.day || day,
        expectedOrders: Math.max(0, Number(form.expectedOrders) || 0),
        expectedQty: Math.max(0, Number(form.expectedQty) || 0),
        packedOrders: Math.max(0, Number(form.packedOrders) || 0),
        packedQty: Math.max(0, Number(form.packedQty) || 0),
        note: (form.note || '').trim(),
        operator,
        createdAt: now,
        updatedAt: now,
      };

      if (editingId != null) {
        const existing = await db.gSheetEntries.get(editingId);
        await db.gSheetEntries.update(editingId, {
          ...payload,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        });
        await logAction('GSHEET_UPDATE', `${name} (${payload.day})`, operator);
        setMessage(`Updated “${name}”`);
      } else {
        await db.gSheetEntries.add(payload);
        await logAction('GSHEET_ADD', `${name} (${payload.day})`, operator);
        setMessage(`Added “${name}”`);
      }
      resetForm();
      await load();
    } catch (e: any) {
      setMessage(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id?: number, name?: string) => {
    if (id == null) return;
    if (!confirm(`Delete sheet entry “${name || id}”?`)) return;
    await db.gSheetEntries.delete(id);
    await logAction('GSHEET_DELETE', String(name || id), operator);
    if (editingId === id) resetForm();
    await load();
  };

  const num = (key: keyof typeof form, value: string) => {
    const n = value === '' ? 0 : Number(value);
    setForm((f) => ({ ...f, [key]: Number.isFinite(n) ? n : 0 }));
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-3 sm:gap-4 max-w-6xl mx-auto w-full pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <div className="shrink-0 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <Link2 className="w-5 h-5 text-accent-sky" />
            G-Sheet links
          </h1>
          <p className="text-sm text-text-secondary mt-0.5">
            Store multiple Google Sheet links by name with expected / packed orders &amp; qty. Daily grand totals below.
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <CalendarDays className="w-4 h-4" />
          Day
          <input
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className="bg-white/[0.04] border border-white/10 rounded-md px-2 py-1.5 text-text-primary text-xs focus:outline-none focus:border-accent-sky"
          />
        </label>
      </div>

      {message && (
        <div className="shrink-0 text-xs rounded-md px-3 py-2 border border-white/10 bg-white/[0.03] text-text-secondary">
          {message}
        </div>
      )}

      {/* Grand totals */}
      <div className="shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['Expected orders', totals.expectedOrders],
          ['Expected qty', totals.expectedQty],
          ['Packed orders', totals.packedOrders],
          ['Packed qty (grand total)', totals.packedQty],
        ].map(([label, val]) => (
          <div key={String(label)} className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
            <div className="text-xl font-semibold text-white tabular-nums mt-0.5">{val}</div>
          </div>
        ))}
      </div>

      <div className="grid lg:grid-cols-5 gap-4 flex-1 min-h-0">
        {/* Editor */}
        <Card className="lg:col-span-2 bg-surface/40 border-white/5 h-fit">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              {editingId != null ? <Pencil className="w-4 h-4 text-accent-sky" /> : <Plus className="w-4 h-4 text-accent-sky" />}
              {editingId != null ? 'Edit sheet entry' : 'Add sheet link'}
            </CardTitle>
            <CardDescription>Full edit access — name, URL, expected &amp; packed metrics.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Ozon morning wave"
                className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white focus:outline-none focus:border-accent-sky"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">Google Sheet link</label>
              <input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white font-mono focus:outline-none focus:border-accent-sky"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">Expected orders</label>
                <input type="number" min={0} value={form.expectedOrders} onChange={(e) => num('expectedOrders', e.target.value)}
                  className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white tabular-nums focus:outline-none focus:border-accent-sky" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">Expected qty</label>
                <input type="number" min={0} value={form.expectedQty} onChange={(e) => num('expectedQty', e.target.value)}
                  className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white tabular-nums focus:outline-none focus:border-accent-sky" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">Packed orders</label>
                <input type="number" min={0} value={form.packedOrders} onChange={(e) => num('packedOrders', e.target.value)}
                  className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white tabular-nums focus:outline-none focus:border-accent-sky" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-text-secondary">Packed qty</label>
                <input type="number" min={0} value={form.packedQty} onChange={(e) => num('packedQty', e.target.value)}
                  className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white tabular-nums focus:outline-none focus:border-accent-sky" />
              </div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-text-secondary">Note</label>
              <textarea
                value={form.note || ''}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                rows={2}
                className="mt-0.5 w-full bg-white/[0.04] border border-white/10 rounded-md px-2.5 py-2 text-xs text-white resize-none focus:outline-none focus:border-accent-sky"
              />
            </div>
            <div className="flex gap-2 pt-1">
              <Button size="sm" className="gap-1.5 flex-1" disabled={busy} onClick={save}>
                <Save className="w-3.5 h-3.5" />
                {editingId != null ? 'Update' : 'Save'}
              </Button>
              {editingId != null && (
                <Button size="sm" variant="outline" className="gap-1" onClick={resetForm}>
                  <X className="w-3.5 h-3.5" /> Cancel
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* List */}
        <Card className="lg:col-span-3 bg-surface/40 border-white/5 flex flex-col min-h-0">
          <CardHeader className="pb-2 shrink-0">
            <CardTitle className="text-sm flex items-center gap-2">
              <Package className="w-4 h-4 text-accent-sky" />
              Sheets for {day}
            </CardTitle>
            <CardDescription>{rows.length} link(s) · offline storage in Dexie</CardDescription>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 overflow-auto p-0">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-void/95">
                <tr className="text-text-secondary uppercase tracking-wider border-b border-white/10">
                  <th className="text-left py-2 px-3">Name</th>
                  <th className="text-right py-2 px-2">Exp ord</th>
                  <th className="text-right py-2 px-2">Exp qty</th>
                  <th className="text-right py-2 px-2">Pack ord</th>
                  <th className="text-right py-2 px-2">Pack qty</th>
                  <th className="text-right py-2 px-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="py-2 px-3">
                      <div className="font-medium text-white">{r.name}</div>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-accent-sky hover:underline inline-flex items-center gap-0.5 max-w-[16rem] truncate"
                        title={r.url}
                      >
                        Open sheet <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                      {r.note && <div className="text-[10px] text-text-secondary mt-0.5">{r.note}</div>}
                    </td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.expectedOrders}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.expectedQty}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{r.packedOrders}</td>
                    <td className="py-2 px-2 text-right tabular-nums font-medium text-white">{r.packedQty}</td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      <button type="button" onClick={() => startEdit(r)} className="p-1 text-text-secondary hover:text-accent-sky" title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => remove(r.id, r.name)} className="p-1 text-text-secondary hover:text-rose-400" title="Delete">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={6} className="py-10 text-center text-text-secondary">
                      No sheet links for this day. Add one on the left.
                    </td>
                  </tr>
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="border-t border-white/10 bg-white/[0.02] font-semibold">
                    <td className="py-2 px-3 text-white">Day grand total</td>
                    <td className="py-2 px-2 text-right tabular-nums text-white">{totals.expectedOrders}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-white">{totals.expectedQty}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-white">{totals.packedOrders}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-accent-sky">{totals.packedQty}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
