import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { db, logAction } from '@/lib/db';
import { useAuth } from '@/lib/auth';
import { hashPasswordLocal } from '@/lib/security';
import { supabase, WMS_TENANT_CODE } from '@/lib/supabase';
import {
  Users, Plus, Shield, User, Trash2, X, UserCog, ScrollText, Clock, Pencil, KeyRound, Check,
} from 'lucide-react';
import type { User as UserType, AuditLog } from '@/lib/db';

type Role = 'admin' | 'operator' | 'supervisor';

export default function UserManagement() {
  const { isAdmin, user: currentUser } = useAuth();
  const [tab, setTab] = useState<'users' | 'logs'>('users');
  const [users, setUsers] = useState<UserType[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ displayName: '', role: 'operator' as Role, password: '' });
  const [newUser, setNewUser] = useState({
    username: '',
    password: '',
    displayName: '',
    role: 'operator' as Role,
  });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const operatorName = currentUser?.displayName || currentUser?.username || 'admin';

  const loadUsers = useCallback(async () => {
    const items = await db.users.toArray();
    setUsers(items.sort((a, b) => a.username.localeCompare(b.username)));
  }, []);

  const loadLogs = useCallback(async () => {
    const items = await db.auditLogs.reverse().limit(150).toArray();
    setLogs(items);
  }, []);

  useEffect(() => {
    loadUsers();
    loadLogs();
  }, [loadUsers, loadLogs]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const handleAddUser = async () => {
    if (!newUser.username.trim() || !newUser.password.trim()) {
      setMessage({ type: 'error', text: 'Username and password are required' });
      return;
    }
    if (newUser.password.trim().length < 4) {
      setMessage({ type: 'error', text: 'Password must be at least 4 characters' });
      return;
    }

    const existing = await db.users.where({ username: newUser.username.trim() }).first();
    if (existing) {
      setMessage({ type: 'error', text: 'Username already exists' });
      return;
    }

    try {
      const hashedPassword = await hashPasswordLocal(newUser.password);
      await db.users.add({
        username: newUser.username.trim(),
        password: hashedPassword,
        role: newUser.role,
        displayName: newUser.displayName.trim() || newUser.username.trim(),
        createdAt: new Date().toISOString(),
      });
      void supabase.rpc('wms_upsert_user_secure', {
        p_username: newUser.username.trim(),
        p_display_name: newUser.displayName.trim() || newUser.username.trim(),
        p_role: newUser.role,
        p_password: newUser.password,
        p_operator: operatorName,
        p_tenant_code: WMS_TENANT_CODE,
      });
      await logAction(
        'USER_CREATE',
        `Created ${newUser.username} (${newUser.role})`,
        operatorName,
      );
      setMessage({ type: 'success', text: `User ${newUser.username} created` });
      setNewUser({ username: '', password: '', displayName: '', role: 'operator' });
      setShowAddForm(false);
      loadUsers();
      loadLogs();
    } catch {
      setMessage({ type: 'error', text: 'Failed to create user' });
    }
  };

  const startEdit = (u: UserType) => {
    if (u.id == null) return;
    setEditingId(u.id);
    setEditForm({
      displayName: u.displayName || u.username,
      role: u.role,
      password: '',
    });
    setShowAddForm(false);
  };

  const handleSaveEdit = async () => {
    if (editingId == null) return;
    const target = users.find((u) => u.id === editingId);
    if (!target) return;

    const updates: Partial<UserType> = {
      displayName: editForm.displayName.trim() || target.username,
      role: editForm.role,
    };
    if (editForm.password.trim()) {
      if (editForm.password.trim().length < 4) {
        setMessage({ type: 'error', text: 'Password must be at least 4 characters' });
        return;
      }
      updates.password = await hashPasswordLocal(editForm.password.trim());
    }

    // Prevent locking yourself out of admin
    if (
      target.username === currentUser?.username &&
      target.role === 'admin' &&
      editForm.role !== 'admin'
    ) {
      setMessage({ type: 'error', text: 'You cannot remove your own admin role' });
      return;
    }

    try {
      await db.users.update(editingId, updates);
      void supabase.rpc('wms_upsert_user_secure', {
        p_username: target.username,
        p_display_name: editForm.displayName.trim() || target.username,
        p_role: editForm.role,
        p_password: editForm.password.trim() || null,
        p_operator: operatorName,
        p_tenant_code: WMS_TENANT_CODE,
      });
      await logAction(
        'USER_UPDATE',
        `Updated ${target.username}: role=${editForm.role}${editForm.password ? ', password reset' : ''}`,
        operatorName,
      );
      setMessage({ type: 'success', text: `User ${target.username} updated` });
      setEditingId(null);
      loadUsers();
      loadLogs();
    } catch {
      setMessage({ type: 'error', text: 'Failed to update user' });
    }
  };

  const handleDeleteUser = async (id: number | undefined, username: string) => {
    if (!id) return;
    if (username === 'admin') {
      setMessage({ type: 'error', text: 'Cannot delete the default admin account' });
      return;
    }
    if (username === currentUser?.username) {
      setMessage({ type: 'error', text: 'Cannot delete your own account' });
      return;
    }
    if (!window.confirm(`Delete user “${username}”? This cannot be undone.`)) return;

    try {
      await db.users.delete(id);
      await logAction('USER_DELETE', `Deleted user ${username}`, operatorName);
      setMessage({ type: 'success', text: `User ${username} deleted` });
      if (editingId === id) setEditingId(null);
      loadUsers();
      loadLogs();
    } catch {
      setMessage({ type: 'error', text: 'Failed to delete user' });
    }
  };

  const getRoleIcon = (role: string) => {
    if (role === 'admin') return <Shield className="w-4 h-4 text-accent-sky" />;
    if (role === 'supervisor') return <UserCog className="w-4 h-4 text-accent-yellow" />;
    return <User className="w-4 h-4 text-text-secondary" />;
  };

  const getRoleBg = (role: string) => {
    if (role === 'admin') return 'bg-accent-sky/20';
    if (role === 'supervisor') return 'bg-accent-yellow/20';
    return 'bg-white/[0.05]';
  };

  const getRoleBadgeStyle = (role: string) => {
    if (role === 'admin') return 'bg-accent-sky/20 text-accent-sky';
    if (role === 'supervisor') return 'bg-accent-yellow/20 text-accent-yellow';
    return 'bg-white/[0.05] text-text-secondary';
  };

  if (!isAdmin) {
    return (
      <div className="glass-panel rounded-lg p-8 text-center max-w-md mx-auto mt-12">
        <Shield className="w-10 h-10 text-accent-red mx-auto mb-3" />
        <h2 className="text-lg font-semibold text-text-primary">Access Denied</h2>
        <p className="text-sm text-text-secondary mt-1">
          Admin privileges are required to manage users.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text-primary flex items-center gap-2">
            <Users className="w-6 h-6 text-accent-sky" />
            User Management
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Create operators, assign roles, reset passwords, review audit logs
          </p>
        </div>
        {tab === 'users' && (
          <button
            type="button"
            onClick={() => {
              setShowAddForm((v) => !v);
              setEditingId(null);
            }}
            className="px-3 py-2 rounded-lg text-xs font-semibold bg-accent-sky text-void flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            Add user
          </button>
        )}
      </div>

      {message && (
        <div
          className={`mb-4 text-xs rounded-md px-3 py-2 border ${
            message.type === 'success'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          type="button"
          onClick={() => setTab('users')}
          className={`px-4 py-2 rounded-md text-xs font-semibold transition-all flex items-center gap-1.5 ${
            tab === 'users'
              ? 'bg-accent-sky/20 text-accent-sky border border-accent-sky/30'
              : 'bg-white/[0.02] text-text-secondary border border-white/[0.06]'
          }`}
        >
          <Users className="w-3.5 h-3.5" />
          Users ({users.length})
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('logs');
            loadLogs();
          }}
          className={`px-4 py-2 rounded-md text-xs font-semibold transition-all flex items-center gap-1.5 ${
            tab === 'logs'
              ? 'bg-accent-sky/20 text-accent-sky border border-accent-sky/30'
              : 'bg-white/[0.02] text-text-secondary border border-white/[0.06]'
          }`}
        >
          <ScrollText className="w-3.5 h-3.5" />
          Audit logs
        </button>
      </div>

      <AnimatePresence mode="wait">
        {tab === 'users' && (
          <motion.div
            key="users"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="space-y-4"
          >
            {showAddForm && (
              <div className="glass-panel rounded-xl p-4 border border-accent-sky/20 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-white">New user</h3>
                  <button type="button" onClick={() => setShowAddForm(false)} className="p-1 hover:bg-white/5 rounded">
                    <X className="w-4 h-4 text-text-secondary" />
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] uppercase text-text-secondary">Username</label>
                    <input
                      className="mt-1 w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white"
                      value={newUser.username}
                      onChange={(e) => setNewUser((s) => ({ ...s, username: e.target.value }))}
                      autoComplete="off"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase text-text-secondary">Password</label>
                    <input
                      type="password"
                      className="mt-1 w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white"
                      value={newUser.password}
                      onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))}
                      autoComplete="new-password"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase text-text-secondary">Display name</label>
                    <input
                      className="mt-1 w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white"
                      value={newUser.displayName}
                      onChange={(e) => setNewUser((s) => ({ ...s, displayName: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] uppercase text-text-secondary">Role</label>
                    <select
                      className="mt-1 w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white"
                      value={newUser.role}
                      onChange={(e) => setNewUser((s) => ({ ...s, role: e.target.value as Role }))}
                    >
                      <option value="operator">Operator</option>
                      <option value="supervisor">Supervisor</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddUser}
                  className="px-4 py-2 rounded-lg bg-accent-sky text-void text-xs font-semibold"
                >
                  Create user
                </button>
              </div>
            )}

            <div className="glass-panel rounded-xl overflow-hidden border border-white/[0.06]">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-secondary uppercase tracking-wider border-b border-white/[0.06] text-[10px]">
                      <th className="text-left py-2.5 px-3">User</th>
                      <th className="text-left py-2.5 px-3">Role</th>
                      <th className="text-left py-2.5 px-3 hidden sm:table-cell">Created</th>
                      <th className="text-right py-2.5 px-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] align-top">
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${getRoleBg(u.role)}`}>
                              {getRoleIcon(u.role)}
                            </div>
                            <div>
                              <div className="font-medium text-white">{u.displayName}</div>
                              <div className="font-mono text-[10px] text-text-secondary">@{u.username}</div>
                            </div>
                          </div>
                          {editingId === u.id && (
                            <div className="mt-3 space-y-2 max-w-sm rounded-lg border border-white/10 bg-white/[0.03] p-3">
                              <div>
                                <label className="text-[10px] text-text-secondary">Display name</label>
                                <input
                                  className="mt-0.5 w-full rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-xs text-white"
                                  value={editForm.displayName}
                                  onChange={(e) => setEditForm((s) => ({ ...s, displayName: e.target.value }))}
                                />
                              </div>
                              <div>
                                <label className="text-[10px] text-text-secondary">Role</label>
                                <select
                                  className="mt-0.5 w-full rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-xs text-white"
                                  value={editForm.role}
                                  onChange={(e) => setEditForm((s) => ({ ...s, role: e.target.value as Role }))}
                                >
                                  <option value="operator">Operator</option>
                                  <option value="supervisor">Supervisor</option>
                                  <option value="admin">Admin</option>
                                </select>
                              </div>
                              <div>
                                <label className="text-[10px] text-text-secondary flex items-center gap-1">
                                  <KeyRound className="w-3 h-3" /> New password (optional)
                                </label>
                                <input
                                  type="password"
                                  className="mt-0.5 w-full rounded-md bg-black/30 border border-white/10 px-2 py-1.5 text-xs text-white"
                                  value={editForm.password}
                                  onChange={(e) => setEditForm((s) => ({ ...s, password: e.target.value }))}
                                  placeholder="Leave blank to keep"
                                  autoComplete="new-password"
                                />
                              </div>
                              <div className="flex gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={handleSaveEdit}
                                  className="px-2.5 py-1.5 rounded-md bg-accent-sky text-void text-[10px] font-semibold flex items-center gap-1"
                                >
                                  <Check className="w-3 h-3" /> Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingId(null)}
                                  className="px-2.5 py-1.5 rounded-md border border-white/10 text-[10px] text-text-secondary"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${getRoleBadgeStyle(u.role)}`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-text-secondary hidden sm:table-cell whitespace-nowrap">
                          {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => startEdit(u)}
                            className="inline-flex p-1.5 rounded-md hover:bg-white/5 text-text-secondary hover:text-accent-sky"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u.id, u.username)}
                            className="inline-flex p-1.5 rounded-md hover:bg-white/5 text-text-secondary hover:text-rose-400"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {users.length === 0 && (
                <p className="text-xs text-text-secondary text-center py-8">No users yet</p>
              )}
            </div>

            <p className="text-[10px] text-text-secondary">
              Roles: <strong className="text-white/70">admin</strong> — full access including this page ·{' '}
              <strong className="text-white/70">supervisor</strong> — operations oversight ·{' '}
              <strong className="text-white/70">operator</strong> — floor workflows
            </p>
          </motion.div>
        )}

        {tab === 'logs' && (
          <motion.div
            key="logs"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="glass-panel rounded-xl border border-white/[0.06] overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-white/[0.06] flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-accent-sky" />
              <h3 className="text-sm font-semibold text-text-primary">System audit logs</h3>
              <span className="ml-auto text-[10px] text-text-secondary">{logs.length} records</span>
            </div>
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-void/95">
                  <tr className="text-text-secondary uppercase tracking-widest border-b border-white/[0.06]">
                    <th className="text-left py-2 px-2">Time</th>
                    <th className="text-left py-2 px-2">User</th>
                    <th className="text-left py-2 px-2">Action</th>
                    <th className="text-left py-2 px-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                      <td className="py-2 px-2 text-text-secondary whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(log.timestamp).toLocaleString()}
                        </div>
                      </td>
                      <td className="py-2 px-2 font-mono text-text-primary">{log.operator}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`px-1.5 py-0.5 rounded-full font-semibold ${
                            log.action.includes('LOGIN')
                              ? 'bg-accent-green/20 text-accent-green'
                              : log.action.includes('FAIL') || log.action.includes('DELETE')
                                ? 'bg-accent-red/20 text-accent-red'
                                : 'bg-accent-sky/20 text-accent-sky'
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-text-secondary max-w-[300px] truncate">{log.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {logs.length === 0 && (
              <p className="text-xs text-text-secondary text-center py-6">No audit logs found</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
