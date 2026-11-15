import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { getSyncState, subscribeSyncState, pullCloudSnapshotToEdge, type SyncSnapshotState } from '@/lib/supabaseSync';
import { isSupabaseConfigured } from '@/lib/supabase';
import { RefreshCw } from 'lucide-react';

interface SyncStatusProps {
  isOnline: boolean;
}

export default function SyncStatus({ isOnline }: SyncStatusProps) {
  const [sync, setSync] = useState<SyncSnapshotState>(getSyncState);
  const waveCount = 5;

  useEffect(() => {
    return subscribeSyncState(setSync);
  }, []);

  const syncing = sync.status === 'syncing';
  const unconfigured = !isSupabaseConfigured || sync.status === 'unconfigured';

  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <div className="flex items-center gap-[1px] h-4">
        {Array.from({ length: waveCount }).map((_, i) => (
          <motion.div
            key={i}
            className={`w-[2px] rounded-full ${
              !isOnline
                ? 'bg-accent-red'
                : unconfigured
                  ? 'bg-accent-sky'
                  : sync.status === 'error'
                    ? 'bg-accent-yellow'
                    : 'bg-accent-green'
            }`}
            style={{ height: '100%' }}
            animate={isOnline && !unconfigured ? { scaleY: [0.25, 1, 0.25] } : { scaleY: 0.45 }}
            transition={
              isOnline && !unconfigured
                ? { duration: syncing ? 0.45 : 1.1, repeat: Infinity, delay: i * 0.1, ease: 'easeInOut' }
                : {}
            }
          />
        ))}
      </div>
      <span className="uppercase tracking-widest text-[10px] sm:text-[11px] flex items-center gap-1.5">
        {unconfigured ? (
          <>
            <span className="text-accent-sky font-semibold">{sync.warehouseCode}</span>
            <span className="hidden sm:inline text-white/45">• EDGE LOCAL MODE</span>
          </>
        ) : isOnline ? (
          <>
            <span className="text-accent-green font-semibold">{sync.warehouseCode}</span>
            <span className="hidden sm:inline text-white/45">
              •{' '}
              {syncing
                ? 'SYNCING'
                : sync.pendingOutbox > 0
                  ? `OUTBOX (${sync.pendingOutbox})`
                  : sync.deadLetterCount > 0
                    ? `DLQ (${sync.deadLetterCount})`
                    : 'CLOUD SYNCED'}
            </span>
          </>
        ) : (
          <>
            <span className="text-accent-red font-semibold">EDGE OFFLINE</span>
            <span className="hidden sm:inline text-white/45">• QUEUED ({sync.pendingOutbox})</span>
          </>
        )}
      </span>
      {isOnline && !unconfigured && (
        <button
          type="button"
          onClick={() => void pullCloudSnapshotToEdge()}
          className="p-1 rounded hover:bg-white/5 text-white/40 hover:text-sky-400 transition-colors"
          title="Reconcile with Supabase PostgreSQL Core"
        >
          <RefreshCw className={`w-3 h-3 ${syncing ? 'animate-spin text-sky-400' : ''}`} />
        </button>
      )}
    </div>
  );
}
