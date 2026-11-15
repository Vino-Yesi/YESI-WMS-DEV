import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ChatMessage } from './aiAssistant';
import { safeLocalStorage, safeRandomId } from './safeStorage';

interface Notification {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  read: boolean;
}

export type DensityMode = 'comfortable' | 'compact';

interface AppState {
  // Notifications
  notifications: Notification[];
  addNotification: (n: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  clearNotifications: () => void;
  unreadCount: () => number;

  // Command palette
  commandPaletteOpen: boolean;
  setCommandPaletteOpen: (open: boolean) => void;

  // App settings
  autoRefresh: boolean;
  setAutoRefresh: (v: boolean) => void;
  refreshInterval: number;
  setRefreshInterval: (v: number) => void;
  lowStockThreshold: number;
  setLowStockThreshold: (v: number) => void;

  // Density / compact UI
  density: DensityMode;
  setDensity: (d: DensityMode) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebarCollapsed: () => void;

  // AI Assistant
  aiAssistantOpen: boolean;
  setAiAssistantOpen: (open: boolean) => void;
  aiChatHistory: ChatMessage[];
  addChatMessage: (msg: ChatMessage) => void;
  clearChatHistory: () => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      notifications: [],
      addNotification: (n) =>
        set((state) => ({
          notifications: [
            {
              ...n,
              id: safeRandomId(),
              timestamp: Date.now(),
              read: false,
            },
            ...state.notifications.slice(0, 49),
          ],
        })),
      markRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n
          ),
        })),
      clearNotifications: () => set({ notifications: [] }),
      unreadCount: () => get().notifications.filter((n) => !n.read).length,

      commandPaletteOpen: false,
      setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

      autoRefresh: true,
      setAutoRefresh: (v) => set({ autoRefresh: v }),
      refreshInterval: 30,
      setRefreshInterval: (v) => set({ refreshInterval: v }),
      lowStockThreshold: 10,
      setLowStockThreshold: (v) => set({ lowStockThreshold: v }),

      density: 'compact',
      setDensity: (d) => set({ density: d }),
      sidebarCollapsed: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      aiAssistantOpen: false,
      setAiAssistantOpen: (open) => set({ aiAssistantOpen: open }),
      aiChatHistory: [],
      addChatMessage: (msg) =>
        set((state) => ({
          aiChatHistory: [...state.aiChatHistory.slice(-49), msg],
        })),
      clearChatHistory: () => set({ aiChatHistory: [] }),
    }),
    {
      name: 'vortex-app-store',
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        autoRefresh: state.autoRefresh,
        refreshInterval: state.refreshInterval,
        lowStockThreshold: state.lowStockThreshold,
        density: state.density,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);
