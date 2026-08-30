/**
 * App.tsx — the route table.
 *
 * Shape, top to bottom:
 *
 *   /login /forgot-password /reset-password     public, no chrome
 *   /portal/*                                   the CUSTOMER portal — its own
 *                                               guard, its own chrome, no agent
 *                                               session anywhere near it
 *   /enroll /sso-enroll                         signed in, still no chrome —
 *                                               a 2FA wizard with a sidebar is a
 *                                               wizard you can wander out of
 *   everything else                             inside <AppLayout />
 *   *                                           NotFoundPage
 *
 * Three decisions worth reading before editing:
 *
 * **The portal is a different application that happens to share a bundle.** It
 * is not a section of the desk with fewer buttons. A portal contact has no
 * `users` row and no membership, so `ProtectedRoute` (which waits on the agent
 * session store) and `AppLayout` (sidebar, palette, tenant switcher) are both
 * wrong for it in kind, not in degree. Its routes therefore sit ABOVE the
 * signed-in tree and carry their own guard, `PortalGuard`, driven by the portal
 * session. Moving them inside `ProtectedRoute` would bounce every customer to
 * the agent login screen.
 *
 * **The ticket queue is ONE route.** `/tickets` and `/tickets/:id` are the same
 * `<Route path="/tickets/:id?">`, not two routes rendering the same component.
 * A single route element means React keeps `TicketsPage` mounted while the id
 * changes, so opening a ticket does not tear down and re-virtualise the queue
 * behind it — the scroll position, the loaded window and the socket
 * subscriptions all survive. Splitting this into two `<Route>`s is a regression
 * even though it looks identical.
 *
 * **Placeholders are honest.** Every module that is planned but not built yet
 * routes to `<ComingSoon>`, which names the module and the phase it lands in.
 * There are no stub pages on disk pretending to be features: a real file called
 * `ReportsPage.tsx` that renders "no data" is indistinguishable from a broken
 * report, and someone eventually ships it.
 */

import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Construction, LayoutGrid } from 'lucide-react';
import { CAPABILITIES } from '@oblidesk/shared';
import { useAuthStore } from '@/store/authStore';
import { ProtectedRoute } from '@/components/layout/ProtectedRoute';
import { AppLayout } from '@/components/layout/AppLayout';
import { Badge } from '@/components/common/Badge';
import { Button } from '@/components/common/Button';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

// The sign-in surfaces stay in the entry chunk: they are the first paint of a
// cold visit, and a spinner in front of the login form buys nothing.
import { LoginPage } from '@/pages/LoginPage';
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage';
import { ResetPasswordPage } from '@/pages/ResetPasswordPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

// ═════════════════════════════════════════════════════════════════════════════
// Lazy chunks
//
// Everything an agent reaches AFTER signing in. The ticket surfaces pull in
// @tanstack/react-virtual, @dnd-kit and recharts; the admin pages pull their own
// tables and modals. Keeping them out of the entry chunk is what makes the login
// screen appear immediately on a slow link.
//
// The `.then()` mapping is deliberate: every page in this app exports a NAMED
// component (`export function TicketsPage`), and naming it here means a typo in
// the import path or a renamed export fails at build time rather than resolving
// to `undefined` and blanking the route at runtime.
// ═════════════════════════════════════════════════════════════════════════════

const ShiftBoardPage = lazy(() =>
  import('@/pages/ShiftBoardPage').then((m) => ({ default: m.ShiftBoardPage })),
);
const TicketsPage = lazy(() =>
  import('@/pages/TicketsPage').then((m) => ({ default: m.TicketsPage })),
);
const SetupPage = lazy(() => import('@/pages/SetupPage').then((m) => ({ default: m.SetupPage })));
const ProfilePage = lazy(() =>
  import('@/pages/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const EnrollmentPage = lazy(() =>
  import('@/pages/EnrollmentPage').then((m) => ({ default: m.EnrollmentPage })),
);
const SsoEnrollPage = lazy(() =>
  import('@/pages/SsoEnrollPage').then((m) => ({ default: m.SsoEnrollPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
const AdminUsersPage = lazy(() =>
  import('@/pages/AdminUsersPage').then((m) => ({ default: m.AdminUsersPage })),
);
const AdminTeamsPage = lazy(() =>
  import('@/pages/AdminTeamsPage').then((m) => ({ default: m.AdminTeamsPage })),
);
const AdminTenantsPage = lazy(() =>
  import('@/pages/AdminTenantsPage').then((m) => ({ default: m.AdminTenantsPage })),
);
const AdminPermissionSetsPage = lazy(() =>
  import('@/pages/AdminPermissionSetsPage').then((m) => ({ default: m.AdminPermissionSetsPage })),
);

// The engines' own surfaces. Dashboards drags recharts in behind it, and both
// the automation and the SLA editors carry a condition builder — none of it
// belongs in the entry chunk.
const DashboardsPage = lazy(() =>
  import('@/pages/DashboardsPage').then((m) => ({ default: m.DashboardsPage })),
);
const AutomationPage = lazy(() =>
  import('@/pages/AutomationPage').then((m) => ({ default: m.AutomationPage })),
);
const SlaPage = lazy(() => import('@/pages/SlaPage').then((m) => ({ default: m.SlaPage })));

// The asset module. Two routes rather than one optional-param route, which is
// the opposite of the ticket queue's choice above and deliberate: the asset
// list is not virtualised and holds no scroll window worth preserving, so
// remounting it costs one keyset page and nothing else.
const AssetsPage = lazy(() =>
  import('@/pages/AssetsPage').then((m) => ({ default: m.AssetsPage })),
);
const AssetDetailPage = lazy(() =>
  import('@/pages/AssetDetailPage').then((m) => ({ default: m.AssetDetailPage })),
);

// The problem module, split the same way and for the same reason: the board is
// a page-paginated table nobody scrolls for an hour, while the folder carries
// the RCA workshop and its evaluators. Neither belongs in the entry chunk.
const ProblemsPage = lazy(() =>
  import('@/pages/ProblemsPage').then((m) => ({ default: m.ProblemsPage })),
);
const ProblemDetailPage = lazy(() =>
  import('@/pages/ProblemDetailPage').then((m) => ({ default: m.ProblemDetailPage })),
);

// The change module, split on the same line and for the same reason: the board
// carries a timeline nobody keeps open for an hour, while the folder carries the
// four shared gate evaluators, the conflict panel and the review. Neither
// belongs in the entry chunk, and neither imports the other — the "raise a
// change" modal lives with the board that owns the button, so opening the
// calendar does not download the folder.
const ChangesPage = lazy(() =>
  import('@/pages/ChangesPage').then((m) => ({ default: m.ChangesPage })),
);
const ChangeDetailPage = lazy(() =>
  import('@/pages/ChangeDetailPage').then((m) => ({ default: m.ChangeDetailPage })),
);

// The agent's side of the portal: the customer directory (organisations,
// contacts, and who among them may read a whole company's tickets).
const AdminPortalPage = lazy(() =>
  import('@/pages/AdminPortalPage').then((m) => ({ default: m.AdminPortalPage })),
);

// ═════════════════════════════════════════════════════════════════════════════
// The customer portal
//
// A SEPARATE surface, not a section of the app. It renders outside `AppLayout`
// and outside `ProtectedRoute` because it has neither of the two things those
// depend on: a portal contact has no `users` row (`requireAuth` reads
// `session.userId`, which a portal session never sets) and no membership
// (`requireTenant` resolves a tenant from one; a requester's tenant is pinned
// in the session by the magic-link token they burned). Its own guard is
// `PortalGuard`, driven by `GET /api/portal/me`.
//
// Lazy for a reason the agent chunks do not share: the overwhelming majority of
// visits to this build never touch the portal, and the overwhelming majority of
// portal visits never touch the desk. Neither audience should download the
// other's application.
// ═════════════════════════════════════════════════════════════════════════════
const PortalLayout = lazy(() =>
  import('@/pages/portal/PortalLayout').then((m) => ({ default: m.PortalLayout })),
);
const PortalLoginPage = lazy(() =>
  import('@/pages/portal/PortalLoginPage').then((m) => ({ default: m.PortalLoginPage })),
);
const PortalVerifyPage = lazy(() =>
  import('@/pages/portal/PortalVerifyPage').then((m) => ({ default: m.PortalVerifyPage })),
);
const PortalTicketsPage = lazy(() =>
  import('@/pages/portal/PortalTicketsPage').then((m) => ({ default: m.PortalTicketsPage })),
);
const PortalTicketDetailPage = lazy(() =>
  import('@/pages/portal/PortalTicketDetailPage').then((m) => ({
    default: m.PortalTicketDetailPage,
  })),
);
const PortalNewTicketPage = lazy(() =>
  import('@/pages/portal/PortalNewTicketPage').then((m) => ({ default: m.PortalNewTicketPage })),
);

// ═════════════════════════════════════════════════════════════════════════════
// Suspense
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Wraps ONE route element rather than the whole `<Routes>` tree, so a chunk that
 * is still downloading suspends the content pane only. Hoisting the boundary
 * above `<AppLayout />` would blank the topbar, the sidebar and the queue rail
 * every time an agent opens the settings page — chrome that flickers reads as
 * a crash.
 */
function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoader />}>{children}</Suspense>;
}

function PageLoader() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoadingSpinner size="lg" label={t('common.loading', 'Chargement…')} />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Planned modules
//
// The roadmap, as data. Each entry becomes a route that renders <ComingSoon>.
// `label` is the inline French fallback demanded by HARD RULE 10 — the module
// name must read as French even if the translation bundle never loads.
//
// Phases:
//   2 — the records that sit next to a ticket. Complete: assets, problems and
//       changes have all shipped and route to their own pages below, so this
//       phase no longer appears in the table.
//   3 — self-service and the shape of a ticket (knowledge, catalog, fields,
//       forms, the configuration studio)
//   4 — the engines (workflows, rules, channels — automation and SLA have
//       shipped and route to their own pages below)
//   5 — the people and the money (on-call, team, time, contracts)
//   6 — reading it all back (reports, config portability — dashboards have
//       shipped)
// ═════════════════════════════════════════════════════════════════════════════

interface PlannedModule {
  path: string;
  labelKey: string;
  /** Inline French fallback — HARD RULE 10. */
  label: string;
  phase: number;
}

const PLANNED_MODULES: readonly PlannedModule[] = [
  { path: '/knowledge', labelKey: 'nav.knowledge', label: 'Base de connaissances', phase: 3 },
  { path: '/catalog', labelKey: 'nav.catalog', label: 'Catalogue de services', phase: 3 },
  { path: '/oncall', labelKey: 'nav.oncall', label: 'Astreinte', phase: 5 },
  { path: '/team', labelKey: 'nav.team', label: 'Équipe', phase: 5 },
  { path: '/time', labelKey: 'nav.time', label: 'Temps', phase: 5 },
  { path: '/contracts', labelKey: 'nav.contracts', label: 'Contrats', phase: 5 },
  { path: '/reports', labelKey: 'nav.reports', label: 'Rapports', phase: 6 },
];

const PLANNED_ADMIN_MODULES: readonly PlannedModule[] = [
  { path: '/admin/config', labelKey: 'nav.admin.config', label: 'Configuration', phase: 3 },
  { path: '/admin/fields', labelKey: 'nav.admin.fields', label: 'Champs', phase: 3 },
  { path: '/admin/forms', labelKey: 'nav.admin.forms', label: 'Formulaires', phase: 3 },
  { path: '/admin/workflows', labelKey: 'nav.admin.workflows', label: 'Workflows', phase: 4 },
  { path: '/admin/rules', labelKey: 'nav.admin.rules', label: 'Règles', phase: 4 },
  {
    path: '/admin/channels',
    labelKey: 'nav.admin.channels',
    label: 'Canaux de notification',
    phase: 4,
  },
  {
    path: '/admin/import-export',
    labelKey: 'nav.admin.importExport',
    label: 'Import / Export',
    phase: 6,
  },
];

/**
 * Paths the shipped chrome already links to, mapped onto the canonical route.
 *
 * `Sidebar.tsx` and `CommandPalette.tsx` were written against an earlier path
 * scheme (`/ci`, `/kb`, `/grid`, `/admin/sla`…). Rather than let those links dead-end
 * on the 404 page, each one redirects to the route that owns the module now.
 * Delete a row here the day its source link is rewritten — an alias with no
 * caller is just a second name for the same page.
 */
const ALIASES: readonly (readonly [from: string, to: string])[] = [
  ['/ci', '/assets'],
  ['/kb', '/knowledge'],
  ['/admin/automation', '/automation'],
  ['/admin/sla', '/sla'],
  ['/admin/contracts', '/contracts'],
  ['/settings', '/admin/settings'],
];

// ═════════════════════════════════════════════════════════════════════════════
// ComingSoon
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The placeholder for a planned module.
 *
 * It says three things and nothing more: which module this is, which build
 * phase ships it, and where the work actually is right now. No fake widgets, no
 * "0" counters, no sample rows — an empty dashboard is read as a broken
 * dashboard, and a placeholder that lies is worse than a placeholder.
 */
function ComingSoon({ labelKey, label, phase }: Omit<PlannedModule, 'path'>) {
  const { t } = useTranslation();
  const module = t(labelKey, label);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-card bg-bg-tertiary text-text-muted">
        <Construction size={22} />
      </div>

      <div className="max-w-md space-y-2">
        <h1 className="font-display text-2xl font-semibold tracking-wide text-text-primary">
          {t('comingSoon.title', '{{module}} arrive bientôt', { module })}
        </h1>
        {/* "Phase 4" reads identically in French and English, so the placeholder
            names its phase without inventing a key the reference bundle does
            not carry. */}
        <div className="flex justify-center">
          <Badge tone="accent" size="sm" mono>
            {t('comingSoon.phase', 'Phase {{phase}}', { phase })}
          </Badge>
        </div>
        <p className="text-[13px] leading-relaxed text-text-muted">
          {t(
            'comingSoon.body',
            "Ce module est en cours de construction. Le reste de l'application fonctionne normalement.",
          )}
        </p>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <Link to="/tickets">
          <Button variant="primary" trailing={<ArrowRight size={15} />}>
            {t('nav.tickets', 'Tickets')}
          </Button>
        </Link>
        <Link to="/">
          <Button variant="ghost" icon={<LayoutGrid size={15} />}>
            {t('comingSoon.back', 'Retour au tableau de garde')}
          </Button>
        </Link>
      </div>
    </div>
  );
}

/**
 * `/queues/:slug` (the sidebar's queue rail) is the ticket queue pre-filtered,
 * not a page of its own — the filter belongs in the URL so the link is
 * shareable and the queue stays one component.
 */
function QueueRedirect() {
  const { slug } = useParams<{ slug: string }>();
  return <Navigate to={`/tickets?queue=${encodeURIComponent(slug ?? '')}`} replace />;
}

// ═════════════════════════════════════════════════════════════════════════════
// App
// ═════════════════════════════════════════════════════════════════════════════

export default function App() {
  const { checkSession } = useAuthStore();

  // One session probe per boot. `ProtectedRoute` waits on `isInitialized`, so a
  // refresh deep inside the app never bounces a signed-in agent to /login.
  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  return (
    <BrowserRouter>
      <Routes>
        {/* ── Public ────────────────────────────────────────────────────── */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />

        {/* ── Customer portal ───────────────────────────────────────────── */}
        {/* Deliberately above the agent tree and outside both `ProtectedRoute`
            and `AppLayout` — see the note by the lazy imports. The sign-in and
            verify screens sit OUTSIDE `PortalLayout` as well: they are the two
            pages that run without a session, and putting them inside the layout
            would mean the layout's guard bouncing them straight back to
            themselves. `/portal/verify` is the exact path the magic-link mail
            builds (`${APP_URL}/portal/verify?token=…&next=…`); renaming it
            silently invalidates every link already sitting in an inbox. */}
        <Route
          path="/portal/login"
          element={
            <Page>
              <PortalLoginPage />
            </Page>
          }
        />
        <Route
          path="/portal/verify"
          element={
            <Page>
              <PortalVerifyPage />
            </Page>
          }
        />
        <Route
          element={
            <Page>
              <PortalLayout />
            </Page>
          }
        >
          <Route
            path="/portal"
            element={
              <Page>
                <PortalTicketsPage />
              </Page>
            }
          />
          <Route
            path="/portal/new"
            element={
              <Page>
                <PortalNewTicketPage />
              </Page>
            }
          />
          <Route
            path="/portal/tickets/:id"
            element={
              <Page>
                <PortalTicketDetailPage />
              </Page>
            }
          />
        </Route>

        {/* Any other `/portal/…` path goes back to the customer's own list.
            Without this it would fall through to the shared 404, whose only
            way out is `/` — which for a requester means the agent application,
            a redirect to `/login`, and an identifier-and-password form they have
            no account for. A mistyped URL must not read as being locked out of
            your own supplier's support. Static segments outrank a splat in
            React Router, so this never shadows the three routes above. */}
        <Route path="/portal/*" element={<Navigate to="/portal" replace />} />

        {/* ── Signed in ─────────────────────────────────────────────────── */}
        <Route element={<ProtectedRoute />}>
          {/* Full-screen wizards: deliberately OUTSIDE the layout. Both exist to
              be finished, and a sidebar is an invitation to leave. */}
          <Route
            path="/enroll"
            element={
              <Page>
                <EnrollmentPage />
              </Page>
            }
          />
          <Route
            path="/sso-enroll"
            element={
              <Page>
                <SsoEnrollPage />
              </Page>
            }
          />

          <Route element={<AppLayout />}>
            {/* ── Work ──────────────────────────────────────────────────── */}
            <Route
              path="/"
              element={
                <Page>
                  <ShiftBoardPage />
                </Page>
              }
            />
            {/* One route, optional id — see the note at the top of the file. */}
            <Route
              path="/tickets/:id?"
              element={
                <Page>
                  <TicketsPage />
                </Page>
              }
            />
            {/* The same queue in kanban. TicketsPage keys the layout off the
                pathname, so no prop crosses the route boundary. */}
            <Route
              path="/board"
              element={
                <Page>
                  <TicketsPage />
                </Page>
              }
            />
            {/* The same queue as a dense table. Like /board it keys the layout
                off the pathname, so no state crosses the route boundary and
                the loaded queue is re-rendered rather than refetched. It used
                to be an alias onto /tickets, which quietly delivered the list
                instead of the grid the sidebar promised. */}
            <Route
              path="/grid"
              element={
                <Page>
                  <TicketsPage />
                </Page>
              }
            />
            <Route path="/queues/:slug" element={<QueueRedirect />} />

            {/* ── Assets ────────────────────────────────────────────────── */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.CI_READ} />}>
              <Route
                path="/assets"
                element={
                  <Page>
                    <AssetsPage />
                  </Page>
                }
              />
              <Route
                path="/assets/:id"
                element={
                  <Page>
                    <AssetDetailPage />
                  </Page>
                }
              />
            </Route>

            {/* ── Problems ──────────────────────────────────────────────── */}
            {/* Gated on TICKET_READ, the same capability the server demands to
                read one. Writing is PROBLEM_RW and is checked per action, not
                per route: an agent who may read the folder still sees it. */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.TICKET_READ} />}>
              <Route
                path="/problems"
                element={
                  <Page>
                    <ProblemsPage />
                  </Page>
                }
              />
              <Route
                path="/problems/:id"
                element={
                  <Page>
                    <ProblemDetailPage />
                  </Page>
                }
              />
            </Route>

            {/* ── Changes ───────────────────────────────────────────────── */}
            {/* Gated on TICKET_READ, the same capability the server demands to
                read one — reading a change rides on reading its ticket, and no
                `change_read` capability exists on purpose. Writing is
                CHANGE_RW, scheduling is CHANGE_SCHEDULE and bypassing a freeze
                is CHANGE_FREEZE_OVERRIDE; all three are checked per action by
                the shared evaluators, not per route, so an agent who may read
                the calendar still sees it with the buttons greyed and the
                reason spelled out. */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.TICKET_READ} />}>
              <Route
                path="/changes"
                element={
                  <Page>
                    <ChangesPage />
                  </Page>
                }
              />
              <Route
                path="/changes/:id"
                element={
                  <Page>
                    <ChangeDetailPage />
                  </Page>
                }
              />
            </Route>

            {/* ── Personal ──────────────────────────────────────────────── */}
            <Route
              path="/profile"
              element={
                <Page>
                  <ProfilePage />
                </Page>
              }
            />
            <Route
              path="/setup"
              element={
                <Page>
                  <SetupPage />
                </Page>
              }
            />

            {/* ── Reading it back ───────────────────────────────────────── */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.REPORT_VIEW} />}>
              {/* One route, optional slug — same reason as the ticket queue.
                  `DashboardsPage` owns which board is on screen; remounting it
                  on every board switch would re-fetch the whole catalogue and
                  drop the widgets it has already resolved. */}
              <Route
                path="/dashboards/:slug?"
                element={
                  <Page>
                    <DashboardsPage />
                  </Page>
                }
              />
            </Route>

            {/* ── The engines ───────────────────────────────────────────── */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.AUTOMATION_ADMIN} />}>
              <Route
                path="/automation"
                element={
                  <Page>
                    <AutomationPage />
                  </Page>
                }
              />
            </Route>
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.SLA_ADMIN} />}>
              <Route
                path="/sla"
                element={
                  <Page>
                    <SlaPage />
                  </Page>
                }
              />
            </Route>

            {/* ── Planned modules ───────────────────────────────────────── */}
            {PLANNED_MODULES.map(({ path, labelKey, label, phase }) => (
              <Route
                key={path}
                path={path}
                element={<ComingSoon labelKey={labelKey} label={label} phase={phase} />}
              />
            ))}

            {/* ── Administration ────────────────────────────────────────── */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.CONFIG_ADMIN} />}>
              <Route
                path="/admin/users"
                element={
                  <Page>
                    <AdminUsersPage />
                  </Page>
                }
              />
              <Route
                path="/admin/teams"
                element={
                  <Page>
                    <AdminTeamsPage />
                  </Page>
                }
              />
              <Route
                path="/admin/permission-sets"
                element={
                  <Page>
                    <AdminPermissionSetsPage />
                  </Page>
                }
              />
              <Route
                path="/admin/settings"
                element={
                  <Page>
                    <SettingsPage />
                  </Page>
                }
              />

              {PLANNED_ADMIN_MODULES.map(({ path, labelKey, label, phase }) => (
                <Route
                  key={path}
                  path={path}
                  element={<ComingSoon labelKey={labelKey} label={label} phase={phase} />}
                />
              ))}
            </Route>

            {/* The customer directory: organisations, contacts, and the grant
                that lets one contact read a whole company's tickets. Gated on
                PORTAL_ADMIN — the same capability `/api/organizations` and
                `/api/portal-admin` demand on every route, READS INCLUDED — and
                not on CONFIG_ADMIN, so the route and the API agree about who
                may open it. This directory carries a customer's mail domains
                and its contact roster; a `config_admin` who was never given
                portal_admin has no business reading it. */}
            <Route element={<ProtectedRoute requiredCapability={CAPABILITIES.PORTAL_ADMIN} />}>
              <Route
                path="/admin/portal"
                element={
                  <Page>
                    <AdminPortalPage />
                  </Page>
                }
              />
            </Route>

            {/* Tenants are the installation's partitioning, not this tenant's
                configuration — a `config_admin` inside one tenant must not be
                able to mint another. Role, not capability, on purpose. */}
            <Route element={<ProtectedRoute requiredRole="admin" />}>
              <Route
                path="/admin/tenants"
                element={
                  <Page>
                    <AdminTenantsPage />
                  </Page>
                }
              />
            </Route>

            {/* ── Aliases for the chrome's older paths ──────────────────── */}
            {ALIASES.map(([from, to]) => (
              <Route key={from} path={from} element={<Navigate to={to} replace />} />
            ))}
          </Route>
        </Route>

        {/* ── 404, always last ──────────────────────────────────────────── */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>

      {/* HARD RULE 11 — no border on a surface. The suite's shared toast style
          carries `!border` to override react-hot-toast's own inline styling;
          the colour is transparent so the rule holds and depth comes from the
          background step plus the card shadow. */}
      <Toaster
        position="top-right"
        toastOptions={{
          className:
            '!bg-bg-secondary !text-text-primary !border !border-transparent !rounded-card !shadow-card',
          duration: 4000,
        }}
      />
    </BrowserRouter>
  );
}
