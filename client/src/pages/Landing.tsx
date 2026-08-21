import { Navigate } from "react-router-dom";
import { useAuthStore } from "../store/authStore";

/**
 * There is no marketing page. Signed in goes to the app, signed out goes to
 * sign in — the root path exists only to pick between the two.
 */
export default function Landing() {
  const token = useAuthStore((s) => s.token);
  return <Navigate to={token ? "/chat" : "/login"} replace />;
}
