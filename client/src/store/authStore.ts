import { create } from "zustand";
import { persist } from "zustand/middleware";
import api from "../lib/axios";

export interface User {
  id: string;
  email: string;
  username: string;
  gender: string;
  isPremium: boolean;
  premiumExpiry?: string | null;
  country?: string | null;
  city?: string | null;
  createdAt: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => void;
  fetchMe: () => Promise<void>;
  clearError: () => void;
}

interface RegisterData {
  email: string;
  password: string;
  username: string;
  gender: string;
  country?: string;
  city?: string;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.post("/auth/login", { email, password });
          set({ user: res.data.user, token: res.data.token, isLoading: false });
        } catch (err: unknown) {
          const axiosErr = err as { response?: { data?: { error?: string } } };
          set({
            error: axiosErr.response?.data?.error || "Login failed",
            isLoading: false,
          });
          throw err;
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const res = await api.post("/auth/register", data);
          set({ user: res.data.user, token: res.data.token, isLoading: false });
        } catch (err: unknown) {
          const axiosErr = err as { response?: { data?: { error?: string } } };
          set({
            error: axiosErr.response?.data?.error || "Registration failed",
            isLoading: false,
          });
          throw err;
        }
      },

      logout: () => {
        set({ user: null, token: null, error: null });
      },

      fetchMe: async () => {
        const token = get().token;
        if (!token) return;
        try {
          const res = await api.get("/auth/me");
          set({ user: res.data.user });
        } catch {
          set({ user: null, token: null });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "omextv-auth",
      partialize: (state) => ({ token: state.token, user: state.user }),
    }
  )
);
