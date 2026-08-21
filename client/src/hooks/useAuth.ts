import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../store/authStore";

export function useAuth() {
  const { user, token, isLoading, error, login, register, logout, fetchMe, clearError } =
    useAuthStore();
  const hasFetched = useRef(false);

  useEffect(() => {
    if (token && !user && !hasFetched.current) {
      hasFetched.current = true;
      fetchMe();
    }
  }, [token, user, fetchMe]);

  const isAuthenticated = !!token && !!user;

  return {
    user,
    token,
    isLoading,
    error,
    isAuthenticated,
    login: useCallback(login, [login]),
    register: useCallback(register, [register]),
    logout: useCallback(logout, [logout]),
    clearError: useCallback(clearError, [clearError]),
  };
}
