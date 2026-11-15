import { useState } from 'react';
import { motion } from 'framer-motion';
import { processReturnTransactional } from '@/lib/lifecycle';
import { useAuth } from '@/lib/auth';
import BarcodeReader from '@/components/BarcodeReader';
import { RotateCcw, AlertTriangle, CheckCircle, Minus, Plus } from 'lucide-react';

const RETURN_REASONS = [
  'Customer Cancelled',
  'Defective/Damaged',
  'Wrong Item Shipped',
  'Undeliverable',
];

export default function Returns() {
  const { user } = useAuth();
  const [orderId, setOrderId] = useState('');
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState('Customer Cancelled');
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  const [scanMode, setScanMode] = useState(false);
  // Returned units must be posted to a named bin + lot so the dimensional ledger
  // keeps them apart from saleable stock.
  const [returnBin, setReturnBin] = useState('RETURNS-DOCK');
  const [returnLot, setReturnLot] = useState('');

  const handleScan = (code: string) => {
    setSku(code);
    setScanMode(false);
  };

  const handleProcessReturn = async () => {
    if (!sku.trim()) {
      setMessage({ type: 'error', text: 'Please scan a returning SKU' });
      return;
    }
    if (!returnBin.trim()) {
      setMessage({ type: 'error', text: 'A receiving bin is required so the return lands in a real stock dimension' });
      return;
    }
    if (quantity < 1) {
      setMessage({ type: 'error', text: 'Quantity must be at least 1' });
      return;
    }

    try {
      const isDefective = reason === 'Defective/Damaged';
      const outcome = await processReturnTransactional({
        orderId: orderId.trim() || undefined,
        sku: sku.trim(),
        quantity,
        reason,
        disposition: isDefective ? 'quarantine' : 'restock',
        operator: user?.displayName || 'Operator',
        operatorRole: user?.role || 'operator',
        // Returned units must land in a named bin and lot, otherwise the
        // dimensional ledger cannot tell them apart from saleable stock.
        receivingBin: returnBin.trim() || undefined,
        lotNumber: returnLot.trim() || undefined,
      });

      if (outcome.routedTo === 'qc_hold') {
        setMessage({
          type: 'warning',
          text: `${outcome.rmaRef}: ${quantity}× ${sku} quarantined at ${outcome.bin} for supervisor disposition.`,
        });
      } else {
        setMessage({
          type: 'success',
          text: `${outcome.rmaRef}: ${quantity}× ${sku} staged at ${outcome.bin} into the Directed Putaway Queue for verified bin restock.`,
        });
      }

      setSku('');
      setOrderId('');
      setQuantity(1);
      setReturnLot('');
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to process return' });
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-text-primary">Returns Processing</h1>
        <p className="text-sm text-text-secondary mt-1">Process inbound returns and restock items</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Return Form */}
        <div className="glass-panel rounded-lg p-6">
          <div className="flex items-center gap-2 mb-6">
            <RotateCcw className="w-5 h-5 text-accent-sky" />
            <h2 className="text-sm font-semibold text-text-primary">Process Return</h2>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">
                Original Order ID (Optional)
              </label>
              <input
                type="text"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value.toUpperCase())}
                className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                placeholder="ORD-XXXX"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest">
                  Returned SKU
                </label>
                <button
                  onClick={() => setScanMode(!scanMode)}
                  className="text-[10px] bg-accent-sky/20 text-accent-sky px-2 py-0.5 rounded-full hover:bg-accent-sky/30 transition-colors"
                >
                  {scanMode ? 'Manual Entry' : 'Scan'}
                </button>
              </div>

              {scanMode ? (
                <BarcodeReader onScan={handleScan} placeholder="Scan returned item..." />
              ) : (
                <input
                  type="text"
                  value={sku}
                  onChange={(e) => setSku(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                  placeholder="Enter SKU"
                />
              )}
            </div>

            <div>
              <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">
                Quantity
              </label>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setQuantity(Math.max(1, quantity - 1))}
                  className="w-8 h-8 rounded-md bg-white/[0.05] flex items-center justify-center text-text-secondary hover:text-text-primary"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="text-sm font-mono text-text-primary w-8 text-center">{quantity}</span>
                <button
                  onClick={() => setQuantity(quantity + 1)}
                  className="w-8 h-8 rounded-md bg-white/[0.05] flex items-center justify-center text-text-secondary hover:text-text-primary"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">
                  Receiving bin
                </label>
                <input
                  type="text"
                  value={returnBin}
                  onChange={(e) => setReturnBin(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                  placeholder="RETURNS-DOCK"
                />
              </div>
              <div>
                <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">
                  Lot (optional)
                </label>
                <input
                  type="text"
                  value={returnLot}
                  onChange={(e) => setReturnLot(e.target.value.toUpperCase())}
                  className="w-full bg-transparent border-b border-white/10 text-text-primary text-sm py-2 px-1 focus:outline-none focus:border-accent-sky transition-colors font-mono"
                  placeholder="RMA lot"
                />
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-text-secondary uppercase tracking-widest mb-1.5">
                Return Reason
              </label>
              <div className="grid grid-cols-2 gap-2">
                {RETURN_REASONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setReason(r)}
                    className={`px-3 py-2 rounded-md text-xs font-medium transition-all border ${
                      reason === r
                        ? 'bg-accent-sky/20 border-accent-sky/40 text-accent-sky'
                        : 'bg-white/[0.02] border-white/[0.06] text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {reason === 'Defective/Damaged' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="p-3 bg-accent-yellow/10 border border-accent-yellow/20 rounded-md flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 text-accent-yellow flex-shrink-0 mt-0.5" />
                <p className="text-xs text-accent-yellow">
                  Defective items will be placed on QC Hold and NOT restocked to active inventory.
                </p>
              </motion.div>
            )}

            {message && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`p-3 rounded-md text-xs ${
                  message.type === 'success'
                    ? 'bg-accent-green/10 border border-accent-green/20 text-accent-green'
                    : message.type === 'warning'
                      ? 'bg-accent-yellow/10 border border-accent-yellow/20 text-accent-yellow'
                      : 'bg-accent-red/10 border border-accent-red/20 text-accent-red'
                }`}
              >
                {message.text}
              </motion.div>
            )}

            <motion.button
              onClick={handleProcessReturn}
              whileTap={{ scale: 0.98 }}
              className="w-full flex items-center justify-center gap-2 py-3 bg-accent-sky text-void font-semibold text-sm rounded-md hover:bg-accent-sky/90 transition-colors active:translate-y-[1px]"
            >
              <CheckCircle className="w-4 h-4" />
              Process Return
            </motion.button>
          </div>
        </div>

        {/* Quick Guide */}
        <div className="glass-panel rounded-lg p-6">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Return Workflow</h3>
          <div className="space-y-4">
            {[
              { step: '1', title: 'Receive Item', desc: 'Accept the returned package from carrier or customer' },
              { step: '2', title: 'Inspect & Scan', desc: 'Check item condition and scan the SKU barcode' },
              { step: '3', title: 'Select Reason', desc: 'Choose the appropriate return reason code' },
              { step: '4', title: 'Process', desc: 'System handles restocking based on condition' },
            ].map(item => (
              <div key={item.step} className="flex gap-3">
                <div className="w-6 h-6 rounded-full bg-accent-sky/20 flex items-center justify-center flex-shrink-0">
                  <span className="text-[10px] font-bold text-accent-sky">{item.step}</span>
                </div>
                <div>
                  <p className="text-xs font-semibold text-text-primary">{item.title}</p>
                  <p className="text-[10px] text-text-secondary">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 pt-4 border-t border-white/[0.06]">
            <h4 className="text-[10px] text-text-secondary uppercase tracking-widest mb-2">Reason Codes</h4>
            <div className="space-y-1.5">
              {RETURN_REASONS.map(r => (
                <div key={r} className="flex items-center gap-2 text-xs">
                  <div className={`w-1.5 h-1.5 rounded-full ${r === 'Defective/Damaged' ? 'bg-accent-red' : 'bg-accent-green'}`} />
                  <span className="text-text-secondary">{r}</span>
                  {r === 'Defective/Damaged' && <span className="text-[9px] text-accent-red ml-auto">QC Hold</span>}
                  {r !== 'Defective/Damaged' && <span className="text-[9px] text-accent-green ml-auto">Restock +qty</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
