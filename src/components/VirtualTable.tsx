import { useRef, useState, useEffect, useMemo, useCallback, type ReactNode, type CSSProperties } from 'react';

export interface VirtualColumn<T> {
  key: string;
  header: ReactNode;
  width?: string | number;
  className?: string;
  render: (row: T, index: number) => ReactNode;
}

interface VirtualTableProps<T> {
  rows: T[];
  columns: VirtualColumn<T>[];
  rowHeight?: number;
  maxHeight?: number | string;
  getRowKey: (row: T, index: number) => string | number;
  emptyMessage?: string;
  className?: string;
  onRowClick?: (row: T, index: number) => void;
  rowClassName?: (row: T, index: number) => string;
}

/**
 * Lightweight windowed table — only mounts rows visible in the scrollport (+ overscan).
 * No external dependency. Ideal for inventory / orders / audit lists with hundreds of rows.
 */
export default function VirtualTable<T>({
  rows,
  columns,
  rowHeight = 36,
  maxHeight = 420,
  getRowKey,
  emptyMessage = 'No records',
  className = '',
  onRowClick,
  rowClassName,
}: VirtualTableProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(typeof maxHeight === 'number' ? maxHeight : 420);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setViewportH(e.contentRect.height);
    });
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const overscan = 8;
  const totalH = rows.length * rowHeight;
  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportH / rowHeight) + overscan * 2;
  const endIdx = Math.min(rows.length, startIdx + visibleCount);
  const offsetY = startIdx * rowHeight;

  const slice = useMemo(() => rows.slice(startIdx, endIdx), [rows, startIdx, endIdx]);

  if (rows.length === 0) {
    return (
      <div className={`rounded-lg border border-white/10 bg-white/[0.02] ${className}`}>
        <p className="py-8 text-center text-xs text-text-secondary">{emptyMessage}</p>
      </div>
    );
  }

  const heightStyle: CSSProperties =
    typeof maxHeight === 'number' ? { maxHeight, height: Math.min(totalH + 40, maxHeight) } : { maxHeight };

  return (
    <div className={`rounded-lg border border-white/10 overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex bg-white/[0.04] border-b border-white/10 sticky top-0 z-10 text-[10px] uppercase tracking-wider text-text-secondary font-semibold">
        {columns.map((col) => (
          <div
            key={col.key}
            className={`px-2 py-2 shrink-0 ${col.className || ''}`}
            style={{ width: col.width, flex: col.width ? undefined : 1, minWidth: 0 }}
          >
            {col.header}
          </div>
        ))}
      </div>

      {/* Body */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="overflow-auto relative"
        style={heightStyle}
      >
        <div style={{ height: totalH, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {slice.map((row, i) => {
              const absIdx = startIdx + i;
              const key = getRowKey(row, absIdx);
              const extra = rowClassName?.(row, absIdx) || '';
              return (
                <div
                  key={key}
                  className={`flex items-center border-b border-white/[0.04] hover:bg-white/[0.03] text-xs text-text-primary ${
                    onRowClick ? 'cursor-pointer' : ''
                  } ${extra}`}
                  style={{ height: rowHeight }}
                  onClick={() => onRowClick?.(row, absIdx)}
                >
                  {columns.map((col) => (
                    <div
                      key={col.key}
                      className={`px-2 truncate shrink-0 ${col.className || ''}`}
                      style={{ width: col.width, flex: col.width ? undefined : 1, minWidth: 0 }}
                    >
                      {col.render(row, absIdx)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="px-2 py-1 border-t border-white/10 text-[10px] text-text-secondary/70">
        {rows.length.toLocaleString()} rows · showing {startIdx + 1}–{endIdx}
      </div>
    </div>
  );
}
