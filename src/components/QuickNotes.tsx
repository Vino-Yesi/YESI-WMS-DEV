import { useState, useEffect, useCallback } from 'react';
import { StickyNote, Plus, Trash2, Pin, Minimize2 } from 'lucide-react';
import { db, type QuickNote } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';

export default function QuickNotes() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState<QuickNote[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const rows = await db.quickNotes.orderBy('createdAt').reverse().limit(50).toArray();
    rows.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
    setNotes(rows);
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const addNote = async () => {
    const body = draft.trim();
    if (!body) return;
    setLoading(true);
    try {
      const now = new Date().toISOString();
      await db.quickNotes.add({
        body,
        createdAt: now,
        updatedAt: now,
        operator: user?.displayName || user?.username || 'Operator',
        pinned: false,
      });
      setDraft('');
      await load();
    } finally {
      setLoading(false);
    }
  };

  const togglePin = async (n: QuickNote) => {
    if (n.id == null) return;
    await db.quickNotes.update(n.id, { pinned: !n.pinned, updatedAt: new Date().toISOString() });
    await load();
  };

  const remove = async (id?: number) => {
    if (id == null) return;
    await db.quickNotes.delete(id);
    await load();
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="fixed z-40 flex items-center gap-2 rounded-full bg-accent-sky px-4 py-2.5 text-xs font-semibold text-void shadow-lg shadow-sky-500/20 hover:bg-sky-400 transition-colors"
        style={{ bottom: 'max(1.25rem, env(safe-area-inset-bottom))', right: 'max(1.25rem, env(safe-area-inset-right))' }}
        title="Quick notes"
      >
        <StickyNote className="w-4 h-4" />
        Notes
      </button>

      {open && (
        <div className="fixed z-40 w-[min(100vw-1.5rem,22rem)] max-h-[min(70vh,28rem)] flex flex-col rounded-xl border border-white/10 bg-void/95 backdrop-blur-md shadow-2xl"
          style={{ bottom: 'max(4.5rem, calc(env(safe-area-inset-bottom) + 3.5rem))', right: 'max(0.75rem, env(safe-area-inset-right))' }}>
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
            <div className="flex items-center gap-2 text-sm font-medium text-white">
              <StickyNote className="w-4 h-4 text-accent-sky" />
              Quick notes
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-text-secondary hover:text-white p-1">
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>
          <div className="p-3 border-b border-white/5 space-y-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a note… (Ctrl+Enter to save)"
              rows={3}
              className="w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs text-white placeholder:text-text-secondary/50 focus:outline-none focus:border-accent-sky"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  addNote();
                }
              }}
            />
            <Button size="sm" className="w-full gap-1.5" disabled={loading || !draft.trim()} onClick={addNote}>
              <Plus className="w-3.5 h-3.5" /> Save note
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
            {notes.length === 0 && (
              <p className="text-[11px] text-text-secondary text-center py-6">No notes yet</p>
            )}
            {notes.map((n) => (
              <div
                key={n.id}
                className={`rounded-md border px-2.5 py-2 text-xs ${
                  n.pinned ? 'border-accent-sky/30 bg-accent-sky/5' : 'border-white/5 bg-white/[0.02]'
                }`}
              >
                <p className="text-white/90 whitespace-pre-wrap break-words">{n.body}</p>
                <div className="mt-1.5 flex items-center justify-between text-[10px] text-text-secondary">
                  <span>
                    {n.operator || '—'} · {new Date(n.createdAt).toLocaleString()}
                  </span>
                  <span className="flex items-center gap-1">
                    <button type="button" onClick={() => togglePin(n)} className="p-0.5 hover:text-accent-sky" title="Pin">
                      <Pin className={`w-3 h-3 ${n.pinned ? 'text-accent-sky' : ''}`} />
                    </button>
                    <button type="button" onClick={() => remove(n.id)} className="p-0.5 hover:text-rose-400" title="Delete">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
