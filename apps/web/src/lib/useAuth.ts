import { createContext, useContext } from "react";

export type AuthUser = {
  id: string;
  email: string;
  role: string;
  tenantId: string;
};

export type AuthState = {
  user: AuthUser | null;
  role: string | null;
  isAdmin: boolean;
  isOperator: boolean;
  isViewer: boolean;
};

const EMPTY: AuthState = { user: null, role: null, isAdmin: false, isOperator: false, isViewer: false };

export const AuthContext = createContext<AuthState>(EMPTY);

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function buildAuthState(user: AuthUser | null): AuthState {
  if (!user) return EMPTY;
  const role = user.role;
  return {
    user,
    role,
    isAdmin: role === "admin",
    isOperator: role === "operator",
    isViewer: role === "viewer",
  };
}
