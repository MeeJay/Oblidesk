import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Capability, UserRole } from '@oblidesk/shared';
import { useAuthStore } from '@/store/authStore';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

interface ProtectedRouteProps {
  /** Coarse gate. Prefer `requiredCapability` — roles are legacy. */
  requiredRole?: UserRole;
  /** Fine gate. Admins always pass (see `hasCapability` in the auth store). */
  requiredCapability?: Capability;
  /** Every listed capability must be held. */
  requiredCapabilities?: Capability[];
  /** Any one of these is enough. */
  anyCapability?: Capability[];
  /** Where an unauthorised (but signed-in) user lands. */
  fallbackPath?: string;
}

/**
 * Route guard. It gates NAVIGATION only — the server re-checks every capability
 * on every request, and a user who edits the URL gets a 403 from the API rather
 * than data. Nothing here is a security boundary.
 *
 * `isInitialized` matters: on a cold load the session check is still in flight
 * and `user` is legitimately null. Redirecting to /login during that window
 * would bounce a signed-in user out on every refresh.
 */
export function ProtectedRoute({
  requiredRole,
  requiredCapability,
  requiredCapabilities,
  anyCapability,
  fallbackPath = '/',
}: ProtectedRouteProps) {
  const { user, isInitialized, isAdmin, hasCapability } = useAuthStore();
  const location = useLocation();

  if (!isInitialized) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg-primary">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!user) {
    // Carry the attempted URL so the login page can bounce back to it — an
    // agent who followed a link to TKT-1042 lands on TKT-1042, not the board.
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  const admin = isAdmin();

  if (requiredRole && !admin && user.role !== requiredRole) {
    return <Navigate to={fallbackPath} replace />;
  }

  if (requiredCapability && !hasCapability(requiredCapability)) {
    return <Navigate to={fallbackPath} replace />;
  }

  if (requiredCapabilities && !requiredCapabilities.every((c) => hasCapability(c))) {
    return <Navigate to={fallbackPath} replace />;
  }

  if (anyCapability && anyCapability.length > 0 && !anyCapability.some((c) => hasCapability(c))) {
    return <Navigate to={fallbackPath} replace />;
  }

  return <Outlet />;
}
