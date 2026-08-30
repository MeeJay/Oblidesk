/**
 * AdminPortalPage — `/admin/portal`
 *
 * The agent's side of the customer portal, which until now had a complete API
 * and no way in at all. Two halves on one page because they are one question:
 * the customer directory on the left, and on the right the requesters who sign
 * in under whichever customer is selected.
 *
 * ── What this screen is really for ──────────────────────────────────────────
 * Designating a contact as a reader of their WHOLE organisation. That single
 * column, `portal_contacts.org_visibility`, decides whether a customer sees the
 * three tickets they filed or the four hundred their company filed, colleagues'
 * included. A mute switch labelled "org_visibility" would be a defect: the
 * person clicking it is an agent doing directory work, not the author of the
 * migration, and nothing on a directory form announces itself as a permission
 * change. So the right is stated three times over, in words:
 *
 *   1. once for the screen, in the strip above the roster;
 *   2. once per row, as the switch's own label ("Reads all of Acme" is a
 *      sentence; a bare toggle is not);
 *   3. once at the moment of granting, in a dialog that names the organisation,
 *      counts its open tickets and says plainly that the contact will be able to
 *      REPLY on them, because that is the consequence nobody expects.
 *
 * Revoking needs no dialog. Narrowing is safe, immediate and audited; only
 * widening is the act that deserves a second look.
 *
 * ── Where the right cannot be granted, and why it says so ───────────────────
 * The right names an organisation, so a contact who belongs to nobody cannot
 * hold it (migration 009 has a CHECK, and the server answers
 * `organization_required` before the CHECK can fire as a raw 23514). Those rows
 * get a disabled switch WITH the reason in view and a button that opens the
 * editor where the organisation is assigned. A greyed control with no
 * explanation makes an agent think the screen is broken.
 *
 * ── Two side effects this page refuses to hide ──────────────────────────────
 * Moving a contact to another organisation revokes their organisation reading,
 * and so does emptying an organisation with "Move contacts out": the right was
 * granted against the customer they are leaving. Both are announced BEFORE the
 * save (the editor warns while the select is still open) and reported after it
 * (the reassign result says how many rights it took away). Every mutation
 * adopts the record the server returns rather than patching the local copy,
 * which is the only way the row can show a revocation the client never asked
 * for.
 *
 * ── Deletion ────────────────────────────────────────────────────────────────
 * An organisation is deletable only while empty of contacts, tickets AND
 * contracts, and a contact is never deletable at all. Both refusals are the
 * server's; this page just reads the counts back with `usage()` so the button
 * is disabled with its reason attached instead of being offered and then
 * refused. Deactivation is the removal on offer for a person, and it bites on
 * their very next request.
 *
 * HARD RULE 11 — there is not one `border` class in this file. Every card, row,
 * pill and button takes its depth from the background step plus `shadow-card`,
 * and hover is a background swap.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowRightLeft,
  Building2,
  Contact,
  Eye,
  Inbox,
  Mail,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { CAPABILITIES, PAGINATION, SEEDED_LOCALES } from '@oblidesk/shared';

import {
  isOrganizationRequired,
  organizationUsageOf,
  organizationsApi,
  portalContactsApi,
  type OrganizationRecord,
  type OrganizationUsage,
  type PortalContactRecord,
  type PortalOrgVisibility,
} from '@/api/portalAdmin.api';
import { errorMessage, toApiError } from '@/api/client';
import { Button } from '@/components/common/Button';
import { EmptyState } from '@/components/common/EmptyState';
import { Input } from '@/components/common/Input';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Modal } from '@/components/common/Modal';
import { Select } from '@/components/common/Select';
import { Toggle } from '@/components/common/Toggle';
import { useDebounce } from '@/hooks/useDebounce';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

const ORG_PAGE_SIZE = 50;
const CONTACT_PAGE_SIZE = 25;
const PICKER_LIMIT = PAGINATION.maxLimit;

/**
 * Which roster the right-hand half is showing. `none` is not a filter an
 * administrator would think to build: it is the queue of contacts mail intake
 * created from an address whose domain matched no organisation, and working it
 * down is half of what this screen is for.
 */
type Scope = { kind: 'all' } | { kind: 'none' } | { kind: 'org'; id: number };

type ActiveFilter = 'any' | 'active' | 'inactive';
type VisibilityFilter = 'any' | PortalOrgVisibility;

function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'org' || b.kind !== 'org' || a.id === b.id;
}

/** `undefined` leaves the parameter off entirely; `false` must survive. */
function activeParam(filter: ActiveFilter): boolean | undefined {
  if (filter === 'active') return true;
  if (filter === 'inactive') return false;
  return undefined;
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════

export function AdminPortalPage() {
  const { t } = useTranslation();
  const hasCapability = useAuthStore((state) => state.hasCapability);
  const allowed = hasCapability(CAPABILITIES.PORTAL_ADMIN);

  // ── Directory ─────────────────────────────────────────────────────────────
  const [orgs, setOrgs] = useState<OrganizationRecord[]>([]);
  const [orgTotal, setOrgTotal] = useState(0);
  const [orgSearch, setOrgSearch] = useState('');
  const [orgsLoading, setOrgsLoading] = useState(true);
  const debouncedOrgSearch = useDebounce(orgSearch, 300);

  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [selectedOrg, setSelectedOrg] = useState<OrganizationRecord | null>(null);
  const [unfiledCount, setUnfiledCount] = useState<number | null>(null);

  // ── Roster ────────────────────────────────────────────────────────────────
  const [contacts, setContacts] = useState<PortalContactRecord[]>([]);
  const [contactTotal, setContactTotal] = useState(0);
  const [contactPage, setContactPage] = useState(1);
  const [contactSearch, setContactSearch] = useState('');
  const [contactsLoading, setContactsLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>('any');
  const [visibilityFilter, setVisibilityFilter] = useState<VisibilityFilter>('any');
  const debouncedContactSearch = useDebounce(contactSearch, 300);

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const [orgEditor, setOrgEditor] = useState<{ org: OrganizationRecord | null } | null>(null);
  const [contactEditor, setContactEditor] = useState<{
    contact: PortalContactRecord | null;
  } | null>(null);
  const [granting, setGranting] = useState<PortalContactRecord | null>(null);
  const [deleting, setDeleting] = useState<OrganizationRecord | null>(null);
  const [reassigning, setReassigning] = useState<OrganizationRecord | null>(null);

  const [denied, setDenied] = useState(false);

  const failed = useCallback(
    (error: unknown, fallback: string) => {
      if (toApiError(error).isForbidden) {
        setDenied(true);
        return;
      }
      toast.error(errorMessage(error, fallback));
    },
    [setDenied],
  );

  // ── Loaders ───────────────────────────────────────────────────────────────

  const loadOrgs = useCallback(async () => {
    setOrgsLoading(true);
    try {
      const page = await organizationsApi.list({
        q: debouncedOrgSearch || undefined,
        limit: ORG_PAGE_SIZE,
        sort: 'name',
        dir: 'asc',
      });
      setOrgs(page.items);
      setOrgTotal(page.total);
      setDenied(false);
    } catch (error) {
      failed(error, t('portalAdmin.orgsLoadFailed', 'Could not load the organisations.'));
    } finally {
      setOrgsLoading(false);
    }
  }, [debouncedOrgSearch, failed, t]);

  /**
   * The size of the "no organisation" queue, read as the `total` of a one-row
   * page rather than a counter endpoint nobody else needs. It is the number
   * that tells an administrator there is filing to do.
   */
  const loadUnfiledCount = useCallback(async () => {
    try {
      const page = await portalContactsApi.list({ organizationId: 'none', limit: 1 });
      setUnfiledCount(page.total);
    } catch {
      // A count is decoration. Losing it must not take the page down with it.
      setUnfiledCount(null);
    }
  }, []);

  const loadContacts = useCallback(async () => {
    setContactsLoading(true);
    try {
      const query = {
        q: debouncedContactSearch || undefined,
        isActive: activeParam(activeFilter),
        orgVisibility: visibilityFilter === 'any' ? undefined : visibilityFilter,
        page: contactPage,
        limit: CONTACT_PAGE_SIZE,
        sort: 'email' as const,
        dir: 'asc' as const,
      };

      // The organisation is taken from the PATH on the scoped route, so the
      // roster of a selected customer cannot be widened by a query parameter.
      const page =
        scope.kind === 'org'
          ? await organizationsApi.contacts(scope.id, query)
          : await portalContactsApi.list({
              ...query,
              organizationId: scope.kind === 'none' ? 'none' : undefined,
            });

      setContacts(page.items);
      setContactTotal(page.total);
      setDenied(false);
    } catch (error) {
      failed(error, t('portalAdmin.contactsLoadFailed', 'Could not load the contacts.'));
    } finally {
      setContactsLoading(false);
    }
  }, [
    activeFilter,
    contactPage,
    debouncedContactSearch,
    failed,
    scope,
    t,
    visibilityFilter,
  ]);

  useEffect(() => {
    if (!allowed) return;
    void loadOrgs();
  }, [allowed, loadOrgs]);

  useEffect(() => {
    if (!allowed) return;
    void loadContacts();
  }, [allowed, loadContacts]);

  useEffect(() => {
    if (!allowed) return;
    void loadUnfiledCount();
  }, [allowed, loadUnfiledCount]);

  // A filter change that keeps the old page number lands on an empty page and
  // reads as "no results" rather than as page 3 of a shorter list.
  useEffect(() => {
    setContactPage(1);
  }, [scope, debouncedContactSearch, activeFilter, visibilityFilter]);

  // Re-adopt the selected organisation from every fresh directory page, so its
  // header counters follow the writes made on the roster beside it. Only when
  // the row is actually present: a search that filters it out must not blank
  // the selection the user is working inside.
  useEffect(() => {
    if (scope.kind !== 'org') return;
    const fresh = orgs.find((org) => org.id === scope.id);
    if (fresh) setSelectedOrg(fresh);
  }, [orgs, scope]);

  /** After any write that can move counters, refresh what the counters live on. */
  const refreshAll = useCallback(async () => {
    await Promise.all([loadOrgs(), loadContacts(), loadUnfiledCount()]);
  }, [loadContacts, loadOrgs, loadUnfiledCount]);

  const selectScope = useCallback((next: Scope, org: OrganizationRecord | null) => {
    setScope(next);
    setSelectedOrg(org);
  }, []);

  // ── Row-level writes ──────────────────────────────────────────────────────

  /**
   * Adopt the server's record. Every mutation returns the whole row precisely
   * because the server may have changed a field the caller never sent: moving a
   * contact revokes their organisation reading, and a locally patched copy would
   * keep showing the right they no longer hold.
   */
  const adopt = useCallback((record: PortalContactRecord) => {
    setContacts((prev) => prev.map((row) => (row.id === record.id ? record : row)));
  }, []);

  const toggleActive = useCallback(
    async (contact: PortalContactRecord, next: boolean) => {
      try {
        adopt(await portalContactsApi.setActive(contact.id, next));
        toast.success(
          next
            ? t('portalAdmin.reactivated', '{{name}} can sign in to the portal again.', {
                name: contact.displayName || contact.email,
              })
            : t(
                'portalAdmin.deactivated',
                '{{name}} can no longer sign in. Any link already in their mailbox is dead.',
                { name: contact.displayName || contact.email },
              ),
        );
      } catch (error) {
        failed(error, t('portalAdmin.activeFailed', 'Could not change the sign-in state.'));
      }
    },
    [adopt, failed, t],
  );

  const revokeReading = useCallback(
    async (contact: PortalContactRecord) => {
      try {
        adopt(await portalContactsApi.setVisibility(contact.id, { orgVisibility: 'own' }));
        toast.success(
          t(
            'portalAdmin.readingRevoked',
            '{{name}} now sees only the tickets they filed themselves. This applies to their next request.',
            { name: contact.displayName || contact.email },
          ),
        );
      } catch (error) {
        failed(error, t('portalAdmin.readingFailed', 'Could not change the reading right.'));
      }
    },
    [adopt, failed, t],
  );

  const grantReading = useCallback(
    async (contact: PortalContactRecord) => {
      try {
        // Name the organisation the confirmation just showed, rather than
        // letting the server fall back to whatever the row holds now. The list
        // was loaded a moment ago; if someone moved this contact to another
        // customer in between, an unqualified grant would hand them THAT
        // company's history while the dialog said a different name.
        const record = await portalContactsApi.setVisibility(contact.id, {
          orgVisibility: 'organization',
          organizationId: contact.organizationId,
        });
        adopt(record);
        setGranting(null);
        toast.success(
          t(
            'portalAdmin.readingGranted',
            '{{name}} now reads every ticket filed by {{org}}.',
            {
              name: record.displayName || record.email,
              org: record.organizationName ?? '',
            },
          ),
        );
      } catch (error) {
        if (isOrganizationRequired(error)) {
          // The row said the switch was available and the server disagreed,
          // which means the record moved under us. Reload rather than argue.
          toast.error(
            t(
              'portalAdmin.grantNeedsOrg',
              'This contact belongs to no organisation, so there is nothing for them to read. Assign one first.',
            ),
          );
          setGranting(null);
          void loadContacts();
          return;
        }
        failed(error, t('portalAdmin.readingFailed', 'Could not change the reading right.'));
      }
    },
    [adopt, failed, loadContacts, t],
  );

  // ── Guards ────────────────────────────────────────────────────────────────

  if (!allowed || denied) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Contact size={22} />}
          title={t('portalAdmin.forbiddenTitle', 'Portal administration is not open to you')}
          description={t(
            'portalAdmin.forbiddenDesc',
            'This screen carries your customers mail domains, their contact roster and who among them reads a whole company ticket history. It needs the portal administration permission.',
          )}
        />
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(contactTotal / CONTACT_PAGE_SIZE));

  const scopeTitle =
    scope.kind === 'org'
      ? (selectedOrg?.name ?? t('portalAdmin.scopeOrg', 'Organisation'))
      : scope.kind === 'none'
        ? t('portalAdmin.scopeUnfiled', 'Filed under no organisation')
        : t('portalAdmin.scopeAll', 'All portal contacts');

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-wide text-text-primary">
            <Contact size={22} className="text-accent" />
            {t('portalAdmin.pageTitle', 'Customer portal')}
          </h1>
          <p className="mt-0.5 max-w-2xl text-sm text-text-muted">
            {t(
              'portalAdmin.pageDesc',
              'The organisations you serve, the people who sign in to the portal on their behalf, and how much of their company each of them is allowed to read.',
            )}
          </p>
        </div>
        <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setOrgEditor({ org: null })}>
          {t('portalAdmin.newOrg', 'New organisation')}
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* ── Left: the directory ──────────────────────────────────────────── */}
        <section className="space-y-3 rounded-card bg-bg-secondary p-3 shadow-card">
          <Input
            size="sm"
            icon={<Search size={13} />}
            value={orgSearch}
            onChange={(event) => setOrgSearch(event.target.value)}
            placeholder={t('portalAdmin.orgSearch', 'Search a name, a slug, a mail domain')}
            aria-label={t('portalAdmin.orgSearchLabel', 'Search organisations')}
          />

          <div className="space-y-1">
            <ScopeRow
              icon={<Users size={14} />}
              label={t('portalAdmin.scopeAll', 'All portal contacts')}
              selected={scope.kind === 'all'}
              onSelect={() => selectScope({ kind: 'all' }, null)}
            />
            <ScopeRow
              icon={<Inbox size={14} />}
              label={t('portalAdmin.scopeUnfiled', 'Filed under no organisation')}
              hint={t(
                'portalAdmin.scopeUnfiledHint',
                'Created by mail intake from an address no domain matched.',
              )}
              count={unfiledCount ?? undefined}
              selected={scope.kind === 'none'}
              onSelect={() => selectScope({ kind: 'none' }, null)}
            />
          </div>

          <div className="px-2 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
            {t('portalAdmin.orgSectionTitle', 'Organisations')}
            {orgTotal > 0 && <span className="ml-1.5">{orgTotal}</span>}
          </div>

          {orgsLoading ? (
            <div className="flex justify-center py-8">
              <LoadingSpinner size="sm" />
            </div>
          ) : orgs.length === 0 ? (
            <p className="px-2 py-6 text-center text-[13px] text-text-muted">
              {orgSearch
                ? t('portalAdmin.orgNoMatch', 'No organisation matches that.')
                : t(
                    'portalAdmin.orgEmpty',
                    'No organisation yet. Create one to group a customer contacts and their tickets.',
                  )}
            </p>
          ) : (
            <div className="space-y-1">
              {orgs.map((org) => (
                <OrgRow
                  key={org.id}
                  org={org}
                  selected={sameScope(scope, { kind: 'org', id: org.id })}
                  onSelect={() => selectScope({ kind: 'org', id: org.id }, org)}
                  contactsLabel={t('portalAdmin.contactCount', '{{count}} contacts', {
                    count: org.contactCount,
                  })}
                  openLabel={t('portalAdmin.openTicketCount', '{{count}} open', {
                    count: org.openTicketCount,
                  })}
                />
              ))}
              {orgTotal > orgs.length && (
                <p className="px-2 py-2 text-[11px] text-text-muted">
                  {t(
                    'portalAdmin.orgTruncated',
                    'Showing {{shown}} of {{total}}. Narrow the search to see the rest.',
                    { shown: orgs.length, total: orgTotal },
                  )}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ── Right: the roster ────────────────────────────────────────────── */}
        <section className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-card bg-bg-secondary p-4 shadow-card">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-text-primary">
                {scope.kind === 'org' ? <Building2 size={17} className="text-accent" /> : null}
                <span className="truncate">{scopeTitle}</span>
              </h2>
              {scope.kind === 'org' && selectedOrg ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                  <span className="font-mono">{selectedOrg.slug}</span>
                  {selectedOrg.domains.length > 0 && (
                    <span className="font-mono">{selectedOrg.domains.join(' ')}</span>
                  )}
                  <span>
                    {t('portalAdmin.openTicketCount', '{{count}} open', {
                      count: selectedOrg.openTicketCount,
                    })}
                  </span>
                </p>
              ) : (
                <p className="mt-0.5 text-xs text-text-muted">
                  {scope.kind === 'none'
                    ? t(
                        'portalAdmin.scopeUnfiledDesc',
                        'These people can sign in and file tickets, but they belong to nobody. Until one is assigned they can never read anything beyond their own tickets.',
                      )
                    : t(
                        'portalAdmin.scopeAllDesc',
                        'Every requester who can sign in to the portal in this tenant.',
                      )}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {scope.kind === 'org' && selectedOrg && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil size={13} />}
                    onClick={() => setOrgEditor({ org: selectedOrg })}
                  >
                    {t('portalAdmin.editOrg', 'Edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ArrowRightLeft size={13} />}
                    onClick={() => setReassigning(selectedOrg)}
                  >
                    {t('portalAdmin.moveContacts', 'Move contacts out')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Trash2 size={13} />}
                    onClick={() => setDeleting(selectedOrg)}
                  >
                    {t('common.delete', 'Delete')}
                  </Button>
                </>
              )}
              <Button
                size="sm"
                variant="accent"
                icon={<Plus size={13} />}
                onClick={() => setContactEditor({ contact: null })}
              >
                {t('portalAdmin.newContact', 'New contact')}
              </Button>
            </div>
          </div>

          <ReadingRightLegend />

          <div className="flex flex-wrap items-end gap-2">
            <Input
              size="sm"
              wrapperClassName="min-w-[220px] flex-1"
              icon={<Search size={13} />}
              value={contactSearch}
              onChange={(event) => setContactSearch(event.target.value)}
              placeholder={t('portalAdmin.contactSearch', 'Search an address, a name, a phone number')}
              aria-label={t('portalAdmin.contactSearchLabel', 'Search contacts')}
            />
            <Select
              size="sm"
              wrapperClassName="w-[170px]"
              aria-label={t('portalAdmin.filterActiveLabel', 'Filter by sign-in state')}
              value={activeFilter}
              onChange={(event) => setActiveFilter(event.target.value as ActiveFilter)}
              options={[
                { value: 'any', label: t('portalAdmin.filterActiveAny', 'Active and blocked') },
                { value: 'active', label: t('portalAdmin.filterActiveOn', 'Can sign in') },
                { value: 'inactive', label: t('portalAdmin.filterActiveOff', 'Blocked') },
              ]}
            />
            <Select
              size="sm"
              wrapperClassName="w-[220px]"
              aria-label={t('portalAdmin.filterReadingLabel', 'Filter by reading right')}
              value={visibilityFilter}
              onChange={(event) => setVisibilityFilter(event.target.value as VisibilityFilter)}
              options={[
                { value: 'any', label: t('portalAdmin.filterReadingAny', 'Any reading right') },
                { value: 'own', label: t('portalAdmin.filterReadingOwn', 'Own tickets only') },
                {
                  value: 'organization',
                  label: t('portalAdmin.filterReadingOrg', 'Reads their whole organisation'),
                },
              ]}
            />
          </div>

          <div className="rounded-card bg-bg-secondary p-2 shadow-card">
            {contactsLoading ? (
              <div className="flex justify-center py-14">
                <LoadingSpinner />
              </div>
            ) : contacts.length === 0 ? (
              <EmptyState
                compact
                icon={<Mail size={22} />}
                title={t('portalAdmin.contactsEmptyTitle', 'No contact here')}
                description={
                  contactSearch || activeFilter !== 'any' || visibilityFilter !== 'any'
                    ? t('portalAdmin.contactsEmptyFiltered', 'Nothing matches these filters.')
                    : t(
                        'portalAdmin.contactsEmptyDesc',
                        'Contacts appear here when you create one, or on their own the first time somebody writes in from a matching mail domain.',
                      )
                }
              />
            ) : (
              <div className="space-y-1.5">
                {contacts.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    showOrganization={scope.kind !== 'org'}
                    onEdit={() => setContactEditor({ contact })}
                    onToggleActive={(next) => void toggleActive(contact, next)}
                    onGrant={() => setGranting(contact)}
                    onRevoke={() => void revokeReading(contact)}
                    onAssignOrg={() => setContactEditor({ contact })}
                  />
                ))}
              </div>
            )}
          </div>

          {pageCount > 1 && (
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span>
                {t('portalAdmin.pageOf', 'Page {{page}} of {{pages}}, {{total}} contacts', {
                  page: contactPage,
                  pages: pageCount,
                  total: contactTotal,
                })}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={contactPage <= 1}
                  onClick={() => setContactPage((value) => value - 1)}
                >
                  {t('common.previous', 'Previous')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={contactPage >= pageCount}
                  onClick={() => setContactPage((value) => value + 1)}
                >
                  {t('common.next', 'Next')}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}

      {orgEditor && (
        <OrganizationEditor
          org={orgEditor.org}
          onClose={() => setOrgEditor(null)}
          onSaved={async (record) => {
            setOrgEditor(null);
            setSelectedOrg(record);
            setScope({ kind: 'org', id: record.id });
            await refreshAll();
          }}
        />
      )}

      {contactEditor && (
        <ContactEditor
          contact={contactEditor.contact}
          defaultOrganizationId={scope.kind === 'org' ? scope.id : null}
          onClose={() => setContactEditor(null)}
          onSaved={async () => {
            setContactEditor(null);
            await refreshAll();
          }}
        />
      )}

      {granting && (
        <GrantReadingDialog
          contact={granting}
          organization={
            granting.organizationId === selectedOrg?.id
              ? selectedOrg
              : (orgs.find((org) => org.id === granting.organizationId) ?? null)
          }
          onCancel={() => setGranting(null)}
          onConfirm={() => grantReading(granting)}
        />
      )}

      {deleting && (
        <DeleteOrganizationDialog
          org={deleting}
          onClose={() => setDeleting(null)}
          onMoveContacts={() => {
            setDeleting(null);
            setReassigning(deleting);
          }}
          onDeleted={async () => {
            setDeleting(null);
            selectScope({ kind: 'all' }, null);
            await refreshAll();
          }}
        />
      )}

      {reassigning && (
        <ReassignContactsDialog
          org={reassigning}
          onClose={() => setReassigning(null)}
          onDone={async () => {
            setReassigning(null);
            await refreshAll();
          }}
        />
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The directory rail
// ═════════════════════════════════════════════════════════════════════════════

function ScopeRow({
  icon,
  label,
  hint,
  count,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={hint}
      className={cn(
        'flex w-full items-center gap-2 rounded-card px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent/12 text-accent' : 'text-text-secondary hover:bg-bg-hover',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="shrink-0 rounded-pill bg-bg-tertiary px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {count}
        </span>
      )}
    </button>
  );
}

function OrgRow({
  org,
  selected,
  onSelect,
  contactsLabel,
  openLabel,
}: {
  org: OrganizationRecord;
  selected: boolean;
  onSelect: () => void;
  contactsLabel: string;
  openLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'w-full rounded-card px-2.5 py-2 text-left transition-colors',
        selected ? 'bg-accent/12' : 'hover:bg-bg-hover',
      )}
    >
      <div className={cn('truncate text-[13px]', selected ? 'text-accent' : 'text-text-primary')}>
        {org.name}
      </div>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-text-muted">
        <span className="truncate">{org.slug}</span>
        <span className="shrink-0">{contactsLabel}</span>
        {org.openTicketCount > 0 && <span className="shrink-0">{openLabel}</span>}
      </div>
    </button>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// The reading right
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Said once for the whole screen, before any switch is touched. The per-row
 * label and the grant dialog say it again; repetition is the point, because the
 * cost of an agent flicking this switch without reading it is a customer
 * reading another customer employee's tickets.
 */
function ReadingRightLegend() {
  const { t } = useTranslation();

  return (
    <div className="flex items-start gap-3 rounded-card bg-bg-tertiary/60 px-4 py-3">
      <Eye size={16} className="mt-0.5 shrink-0 text-accent" />
      <p className="text-[12px] leading-relaxed text-text-secondary">
        <span className="font-medium text-text-primary">
          {t('portalAdmin.legendTitle', 'What a contact reads on the portal.')}
        </span>{' '}
        {t(
          'portalAdmin.legendBody',
          'By default a requester opens only the tickets they filed themselves. Granting organisation reading lets them open, and reply to, every ticket their organisation has ever filed, including the ones their colleagues opened. Internal notes are never shown either way, and no other organisation becomes visible.',
        )}
      </p>
    </div>
  );
}

function ContactRow({
  contact,
  showOrganization,
  onEdit,
  onToggleActive,
  onGrant,
  onRevoke,
  onAssignOrg,
}: {
  contact: PortalContactRecord;
  showOrganization: boolean;
  onEdit: () => void;
  onToggleActive: (next: boolean) => void;
  onGrant: () => void;
  onRevoke: () => void;
  onAssignOrg: () => void;
}) {
  const { t } = useTranslation();

  const reads = contact.orgVisibility === 'organization';
  const orphan = contact.organizationId === null;
  const orgName = contact.organizationName ?? '';

  return (
    // Flex rather than a grid with explicit placement: the reading-right cell
    // needs a real minimum width to stay a sentence, and a grid that has to be
    // told where its last child goes is a grid one added column away from
    // stacking two controls on top of each other.
    <div className="flex flex-wrap items-start gap-x-5 gap-y-3 rounded-card bg-bg-tertiary/40 px-3 py-2.5 transition-colors hover:bg-bg-hover">
      {/* Identity */}
      <div className="min-w-[190px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] text-text-primary">
            {contact.displayName || contact.email}
          </span>
          {!contact.isActive && (
            <span className="shrink-0 rounded-pill bg-status-cancelled-bg px-1.5 py-0.5 text-[10px] text-status-cancelled">
              {t('portalAdmin.blocked', 'Blocked')}
            </span>
          )}
          {contact.userId !== null && (
            <span
              className="shrink-0 rounded-pill bg-accent/12 px-1.5 py-0.5 text-[10px] text-accent"
              title={t(
                'portalAdmin.alsoAgentHint',
                'This person also holds an agent account. The two are separate identities, and the switches on this row govern only the portal one.',
              )}
            >
              {t('portalAdmin.alsoAgent', 'Also an agent')}
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] text-text-muted">
          {contact.email}
          {contact.phone ? ` ${contact.phone}` : ''}
        </div>
        {showOrganization && (
          <div className="mt-0.5 truncate text-[11px] text-text-muted">
            {orphan ? (
              t('portalAdmin.noOrganization', 'No organisation')
            ) : (
              <>
                {orgName} <span className="font-mono">{contact.organizationSlug}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Sign-in */}
      <div className="min-w-[120px]">
        <Toggle
          size="sm"
          checked={contact.isActive}
          onChange={onToggleActive}
          label={t('portalAdmin.canSignIn', 'Can sign in')}
          aria-label={t('portalAdmin.canSignInAria', 'Portal sign-in for {{name}}', {
            name: contact.displayName || contact.email,
          })}
        />
      </div>

      {/* THE reading right */}
      <div className="min-w-[250px] max-w-[340px] flex-1">
        <Toggle
          size="sm"
          checked={reads}
          disabled={orphan}
          disabledReason={t(
            'portalAdmin.readingDisabledReason',
            'This contact belongs to no organisation, so there is nothing wider for them to read.',
          )}
          onChange={(next) => (next ? onGrant() : onRevoke())}
          aria-label={t('portalAdmin.readingAria', 'Organisation wide reading for {{name}}', {
            name: contact.displayName || contact.email,
          })}
          label={
            reads
              ? t('portalAdmin.readsOrg', 'Reads all of {{org}}', { org: orgName })
              : t('portalAdmin.readsOwn', 'Reads their own tickets only')
          }
          description={
            orphan
              ? t(
                  'portalAdmin.readingNeedsOrg',
                  'No organisation, so there is nothing wider to read. Assign one first.',
                )
              : reads
                ? t(
                    'portalAdmin.readsOrgHint',
                    'Sees and answers every ticket their colleagues filed for this customer.',
                  )
                : t('portalAdmin.readsOwnHint', 'Sees nothing their colleagues filed.')
          }
        />
        {orphan && (
          // Outside the Toggle, never in its `description`: a <button> nested
          // inside the switch's own <label> is a second control the label would
          // also activate, and the way out of a disabled state must not share a
          // hit area with the thing it is disabled by.
          <button
            type="button"
            onClick={onAssignOrg}
            className="ml-[3rem] mt-1 flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-[11px] text-accent transition-colors hover:bg-bg-hover"
          >
            <AlertTriangle size={11} className="shrink-0" />
            {t('portalAdmin.assignOrganization', 'Assign an organisation')}
          </button>
        )}
      </div>

      <div className="flex items-center">
        <button
          type="button"
          onClick={onEdit}
          title={t('common.edit', 'Edit')}
          aria-label={t('portalAdmin.editContactAria', 'Edit {{name}}', {
            name: contact.displayName || contact.email,
          })}
          className="rounded-pill p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <Pencil size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * The grant, spelled out at the moment it is made.
 *
 * The line about REPLYING is the one that earns this dialog: the portal resolves
 * a ticket for a reply through the same visibility predicate it uses for a read,
 * so organisation reading also lets this person answer on a colleague's ticket,
 * and a reply on a resolved ticket reopens it. Nobody infers that from a switch.
 */
function GrantReadingDialog({
  contact,
  organization,
  onCancel,
  onConfirm,
}: {
  contact: PortalContactRecord;
  organization: OrganizationRecord | null;
  onCancel: () => void;
  /** Resolves when the grant has been attempted, refused included. */
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);

  const name = contact.displayName || contact.email;
  const org = contact.organizationName ?? organization?.name ?? '';
  const openCount = organization?.openTicketCount ?? 0;

  const points: string[] = [
    t(
      'portalAdmin.grantPointReply',
      'They can also reply on those tickets. A reply on a resolved ticket reopens it.',
    ),
    openCount > 0
      ? t('portalAdmin.grantPointOpen', '{{count}} tickets are open for {{org}} right now, and every future one is included.', {
          count: openCount,
          org,
        })
      : t('portalAdmin.grantPointFuture', 'Every ticket this organisation files from now on is included.'),
    t(
      'portalAdmin.grantPointInternal',
      'Internal notes stay hidden, and no other organisation becomes visible.',
    ),
    t(
      'portalAdmin.grantPointImmediate',
      'It applies on their next request. Revoking it is just as immediate.',
    ),
    t(
      'portalAdmin.grantPointMove',
      'Moving this contact to another organisation revokes it automatically, because the right names {{org}}.',
      { org },
    ),
  ];

  return (
    <Modal
      open
      onClose={onCancel}
      size="md"
      closeLabel={t('common.close', 'Close')}
      title={t('portalAdmin.grantTitle', 'Let {{name}} read all of {{org}}?', { name, org })}
      subtitle={contact.email}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={working}
            icon={<Eye size={13} />}
            onClick={() => {
              // `finally` and not `then`: a refused grant leaves this dialog
              // open, and a button that spins forever is how an agent concludes
              // the screen is broken and clicks again.
              setWorking(true);
              void onConfirm().finally(() => setWorking(false));
            }}
          >
            {t('portalAdmin.grantConfirm', 'Grant the reading right')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-2">
        <p className="text-[13px] leading-relaxed text-text-primary">
          {t(
            'portalAdmin.grantLead',
            '{{name}} will be able to open every ticket {{org}} has ever filed through the portal, including the ones their colleagues opened and the replies on them.',
            { name, org },
          )}
        </p>
        <ul className="space-y-1.5">
          {points.map((point) => (
            <li key={point} className="flex gap-2 text-[12px] leading-relaxed text-text-secondary">
              <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-accent" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Editors
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The organisation options behind a picker, fetched here rather than handed
 * down from the directory rail.
 *
 * The rail is filtered by its own search box, and reusing it would be wrong
 * twice over. Mildly: an agent who typed "acme" on the left opens a contact and
 * finds a picker offering only Acme. Seriously: a `<select>` whose value matches
 * no option displays the FIRST one while the state still holds the old id, so an
 * unrelated field edit would save the contact into whichever organisation
 * happens to sort first. `mustInclude` closes that from the other side, keeping
 * the record's current organisation in the list even when it falls outside the
 * slice this fetch returned.
 */
function useOrganizationOptions(
  mustIncludeId: number | null,
  mustIncludeName: string | null,
): { options: Array<{ value: string; label: string }>; truncated: boolean } {
  const [items, setItems] = useState<OrganizationRecord[]>([]);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    organizationsApi
      .list({ limit: PICKER_LIMIT, sort: 'name', dir: 'asc' })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setTruncated(page.total > page.items.length);
      })
      .catch(() => {
        // The picker degrades to whatever `mustInclude` carries, which keeps an
        // edit safe: the current organisation stays selectable even offline.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const options = useMemo(() => {
    const byId = new Map<string, string>();
    for (const org of items) byId.set(String(org.id), org.name);
    if (mustIncludeId !== null) byId.set(String(mustIncludeId), mustIncludeName ?? String(mustIncludeId));
    return [...byId.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [items, mustIncludeId, mustIncludeName]);

  return { options, truncated };
}

/**
 * Domains are edited as one line per domain. A comma-separated field looks
 * tidier and then silently accepts "acme.example, acme.fr" as a single value
 * with a space in it, which matches no sender and looks like a working rule.
 */
function parseDomains(raw: string): { domains: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const line of raw.split(/[\s,;]+/)) {
    const value = line.trim().toLowerCase().replace(/^@+/, '');
    if (value === '') continue;
    // The same shape the server's `domainSchema` demands: labels, dots, and a
    // TLD. Judging it here is not duplication for its own sake — the server's
    // field errors were being swallowed by the generic toast, so typing "acme"
    // produced a failed save with no explanation and nothing kept.
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
      seen.add(value);
    } else if (!invalid.includes(value)) {
      invalid.push(value);
    }
  }
  return { domains: [...seen], invalid };
}

function OrganizationEditor({
  org,
  onClose,
  onSaved,
}: {
  org: OrganizationRecord | null;
  onClose: () => void;
  onSaved: (record: OrganizationRecord) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(org?.name ?? '');
  const [slug, setSlug] = useState(org?.slug ?? '');
  const [domains, setDomains] = useState((org?.domains ?? []).join('\n'));
  const [externalRef, setExternalRef] = useState(org?.externalRef ?? '');
  const [saving, setSaving] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);

  const editing = org !== null;
  const slugChanged = editing && slug.trim() !== org.slug;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (name.trim() === '') {
      toast.error(t('portalAdmin.nameRequired', 'A name is required.'));
      return;
    }

    setSaving(true);
    setSlugError(null);
    try {
      const parsed = parseDomains(domains);
      if (parsed.invalid.length > 0) {
        setSaving(false);
        toast.error(
          t('portalAdmin.orgDomainsInvalid', 'Not a domain: {{list}}', {
            list: parsed.invalid.join(', '),
          }),
        );
        return;
      }
      const record = editing
        ? await organizationsApi.update(org.id, {
            name: name.trim(),
            // Sending an unchanged slug would be a no-op the server diffs away,
            // but leaving it out keeps a rename out of the audit trail unless
            // somebody really renamed it.
            ...(slugChanged ? { slug: slug.trim() } : {}),
            domains: parsed.domains,
            externalRef: externalRef.trim() || null,
          })
        : await organizationsApi.create({
            name: name.trim(),
            ...(slug.trim() ? { slug: slug.trim() } : {}),
            domains: parsed.domains,
            externalRef: externalRef.trim() || null,
          });

      toast.success(
        editing
          ? t('portalAdmin.orgUpdated', 'Organisation saved.')
          : t('portalAdmin.orgCreated', 'Organisation {{name}} created with the slug {{slug}}.', {
              name: record.name,
              slug: record.slug,
            }),
      );
      await onSaved(record);
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.code === 'slug_taken') {
        setSlugError(
          t('portalAdmin.slugTaken', 'Another organisation already uses that slug.'),
        );
      } else {
        toast.error(errorMessage(error, t('portalAdmin.orgSaveFailed', 'Could not save.')));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      closeLabel={t('common.close', 'Close')}
      title={
        editing
          ? t('portalAdmin.orgEditTitle', 'Edit organisation')
          : t('portalAdmin.orgCreateTitle', 'New organisation')
      }
      subtitle={editing ? org.slug : undefined}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void submit()}>
            {t('common.save', 'Save')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4 pb-2">
        <Input
          label={t('portalAdmin.orgName', 'Name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('portalAdmin.orgNamePlaceholder', 'Acme Industries')}
          autoFocus
        />

        <Input
          label={t('portalAdmin.orgSlug', 'Slug')}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          error={slugError ?? undefined}
          placeholder={
            editing
              ? undefined
              : t('portalAdmin.orgSlugPlaceholder', 'Leave empty to derive it from the name')
          }
          hint={
            slugChanged
              ? t(
                  'portalAdmin.orgSlugRenameWarning',
                  'SLA policies match customers on this slug. Renaming it re-points every policy that named the old value, so check them afterwards.',
                )
              : t(
                  'portalAdmin.orgSlugHint',
                  'The handle other configuration refers to this customer by. Lowercase letters, digits and hyphens.',
                )
          }
        />

        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-text-secondary">
            {t('portalAdmin.orgDomains', 'Mail domains, one per line')}
          </span>
          <textarea
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            rows={3}
            spellCheck={false}
            placeholder={t('portalAdmin.orgDomainsPlaceholder', 'acme.example')}
            className="w-full rounded-card bg-bg-tertiary px-3 py-2 font-mono text-[12px] text-text-primary outline-none transition-shadow placeholder:text-text-muted focus:ring-1 focus:ring-accent"
          />
          <span className="text-[11px] leading-relaxed text-text-muted">
            {t(
              'portalAdmin.orgDomainsHint',
              'Mail arriving from these domains is filed under this customer automatically. Never put a public domain here: it would file every consumer address on the internet under this organisation.',
            )}
          </span>
        </label>

        <Input
          label={t('portalAdmin.orgExternalRef', 'Reference in your billing system')}
          value={externalRef}
          onChange={(event) => setExternalRef(event.target.value)}
          hint={t('portalAdmin.orgExternalRefHint', 'Optional. Never used for matching.')}
        />
      </form>
    </Modal>
  );
}

function ContactEditor({
  contact,
  defaultOrganizationId,
  onClose,
  onSaved,
}: {
  contact: PortalContactRecord | null;
  defaultOrganizationId: number | null;
  onClose: () => void;
  onSaved: (record: PortalContactRecord) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const editing = contact !== null;

  const [email, setEmail] = useState(contact?.email ?? '');
  const [displayName, setDisplayName] = useState(contact?.displayName ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [organizationId, setOrganizationId] = useState<string>(
    String(contact?.organizationId ?? defaultOrganizationId ?? ''),
  );
  const [locale, setLocale] = useState<string>(
    contact?.locale && SEEDED_LOCALES.includes(contact.locale as 'en' | 'fr')
      ? contact.locale
      : 'fr',
  );
  const [saving, setSaving] = useState(false);

  const { options, truncated } = useOrganizationOptions(
    contact?.organizationId ?? null,
    contact?.organizationName ?? null,
  );

  const orgOptions = useMemo(
    () => [{ value: '', label: t('portalAdmin.noOrganization', 'No organisation') }, ...options],
    [options, t],
  );

  /**
   * The one warning that has to appear BEFORE the save rather than in the toast
   * after it: moving a contact who reads their whole organisation revokes that
   * right, because it named the organisation they are leaving.
   */
  const willRevoke =
    editing &&
    contact.orgVisibility === 'organization' &&
    String(contact.organizationId ?? '') !== organizationId;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    try {
      const orgId = organizationId === '' ? null : Number(organizationId);
      const record = editing
        ? await portalContactsApi.update(contact.id, {
            displayName: displayName.trim() || null,
            phone: phone.trim() || null,
            organizationId: orgId,
            locale: locale as 'en' | 'fr',
          })
        : await portalContactsApi.create({
            email: email.trim().toLowerCase(),
            displayName: displayName.trim() || null,
            phone: phone.trim() || null,
            organizationId: orgId,
            locale: locale as 'en' | 'fr',
          });

      toast.success(
        editing
          ? record.orgVisibility === 'own' && contact.orgVisibility === 'organization'
            ? t(
                'portalAdmin.contactMovedRevoked',
                'Contact saved. Their organisation wide reading was revoked by the move.',
              )
            : t('portalAdmin.contactUpdated', 'Contact saved.')
          : t(
              'portalAdmin.contactCreated',
              '{{email}} can now sign in. They read only their own tickets until you say otherwise.',
              { email: record.email },
            ),
      );
      await onSaved(record);
    } catch (error) {
      toast.error(errorMessage(error, t('portalAdmin.contactSaveFailed', 'Could not save.')));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      closeLabel={t('common.close', 'Close')}
      title={
        editing
          ? t('portalAdmin.contactEditTitle', 'Edit contact')
          : t('portalAdmin.contactCreateTitle', 'New portal contact')
      }
      subtitle={editing ? contact.email : undefined}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button variant="primary" size="sm" loading={saving} onClick={() => void submit()}>
            {t('common.save', 'Save')}
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4 pb-2">
        {editing ? (
          <div className="rounded-card bg-bg-tertiary/60 px-3 py-2">
            <div className="font-mono text-[12px] text-text-primary">{contact.email}</div>
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
              {t(
                'portalAdmin.emailImmutable',
                'An address cannot be edited. It is where sign-in links are sent, what inbound mail threads on, and the identity every ticket this person filed is attributed to. A different address is a different person: create one and block this one.',
              )}
            </p>
          </div>
        ) : (
          <Input
            type="email"
            label={t('portalAdmin.contactEmail', 'Email address')}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={t('portalAdmin.contactEmailPlaceholder', 'name@acme.example')}
            hint={t(
              'portalAdmin.contactEmailHint',
              'Sign-in links go here. It cannot be changed afterwards.',
            )}
            autoFocus
          />
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={t('portalAdmin.contactName', 'Display name')}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Input
            label={t('portalAdmin.contactPhone', 'Phone')}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label={t('portalAdmin.contactOrganization', 'Organisation')}
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            options={orgOptions}
            hint={
              truncated
                ? t(
                    'portalAdmin.pickerTruncated',
                    'Only the first {{count}} organisations are listed here.',
                    { count: PICKER_LIMIT },
                  )
                : undefined
            }
          />
          <Select
            label={t('portalAdmin.contactLocale', 'Language of their sign-in mail')}
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
            options={SEEDED_LOCALES.map((code) => ({ value: code, label: code }))}
          />
        </div>

        {willRevoke && (
          <p className="flex items-start gap-2 rounded-card bg-sla-warn-bg px-3 py-2 text-[12px] leading-relaxed text-sla-warn">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {t(
                'portalAdmin.moveRevokesWarning',
                'This person currently reads every ticket of {{org}}. Moving them revokes that, because the right was granted against {{org}} and not against the new customer. Grant it again afterwards if they need it.',
                { org: contact.organizationName ?? '' },
              )}
            </span>
          </p>
        )}

        {!editing && (
          <p className="text-[11px] leading-relaxed text-text-muted">
            {t(
              'portalAdmin.createReadsOwnHint',
              'A new contact reads only the tickets they file themselves. Organisation wide reading is granted afterwards, from the roster.',
            )}
          </p>
        )}
      </form>
    </Modal>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Destructive paths
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The delete asks the server what stands in the way BEFORE offering the button.
 *
 * Nothing here is a cascade and nothing is an archive. Three foreign keys make
 * a silent delete data loss: contracts are `ON DELETE CASCADE`, tickets and
 * contacts are `SET NULL`. So the honest screen is one that names the counts,
 * offers the one thing that can actually be emptied (the contacts) and says
 * plainly that tickets and contracts cannot.
 */
function DeleteOrganizationDialog({
  org,
  onClose,
  onMoveContacts,
  onDeleted,
}: {
  org: OrganizationRecord;
  onClose: () => void;
  onMoveContacts: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<OrganizationUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    organizationsApi
      .usage(org.id)
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(
            errorMessage(error, t('portalAdmin.usageFailed', 'Could not read what is attached.')),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [org.id, t]);

  const empty =
    usage !== null &&
    usage.contactCount === 0 &&
    usage.ticketCount === 0 &&
    usage.contractCount === 0;

  async function remove() {
    setWorking(true);
    try {
      await organizationsApi.remove(org.id);
      toast.success(t('portalAdmin.orgDeleted', '{{name}} deleted.', { name: org.name }));
      await onDeleted();
    } catch (error) {
      const blocked = organizationUsageOf(error);
      if (blocked) {
        // Somebody attached something between the check and the click.
        setUsage(blocked);
        toast.error(
          t(
            'portalAdmin.orgNotEmpty',
            'Something was attached to this organisation in the meantime. Nothing was deleted.',
          ),
        );
      } else {
        toast.error(errorMessage(error, t('portalAdmin.orgDeleteFailed', 'Could not delete.')));
      }
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      closeOnBackdrop={false}
      closeLabel={t('common.close', 'Close')}
      title={t('portalAdmin.deleteTitle', 'Delete {{name}}?', { name: org.name })}
      subtitle={org.slug}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          {usage !== null && usage.contactCount > 0 && (
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowRightLeft size={13} />}
              onClick={onMoveContacts}
            >
              {t('portalAdmin.moveContacts', 'Move contacts out')}
            </Button>
          )}
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={13} />}
            loading={working}
            disabled={!empty}
            onClick={() => void remove()}
          >
            {t('common.delete', 'Delete')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 pb-2">
        {loading ? (
          <div className="flex justify-center py-8">
            <LoadingSpinner size="sm" />
          </div>
        ) : usage === null ? (
          <p className="text-[13px] text-text-muted">
            {t('portalAdmin.usageUnknown', 'What is attached to this organisation is unknown, so the delete stays closed.')}
          </p>
        ) : empty ? (
          <p className="text-[13px] leading-relaxed text-text-primary">
            {t(
              'portalAdmin.deleteEmpty',
              'Nothing is attached to this organisation. Deleting it removes the record and its mail domains, and mail from those domains stops being filed under a customer.',
            )}
          </p>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-text-primary">
              {t(
                'portalAdmin.deleteBlocked',
                'This organisation cannot be deleted while anything still points at it.',
              )}
            </p>
            <ul className="space-y-1.5">
              <UsageLine
                count={usage.contactCount}
                text={t('portalAdmin.usageContacts', '{{count}} contacts, of whom {{readers}} read the whole organisation.', {
                  count: usage.contactCount,
                  readers: usage.orgReaderCount,
                })}
                fixable
              />
              <UsageLine
                count={usage.ticketCount}
                text={t(
                  'portalAdmin.usageTickets',
                  '{{count}} tickets, {{open}} of them still open. A delete would blank the only column saying whose they were, so there is no way around this one.',
                  { count: usage.ticketCount, open: usage.openTicketCount },
                )}
              />
              <UsageLine
                count={usage.contractCount}
                text={t(
                  'portalAdmin.usageContracts',
                  '{{count}} contracts. These would be deleted with the organisation, block hours and all, so they have to be dealt with first.',
                  { count: usage.contractCount },
                )}
              />
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

function UsageLine({
  count,
  text,
  fixable,
}: {
  count: number;
  text: string;
  fixable?: boolean;
}) {
  if (count === 0) return null;
  return (
    <li className="flex gap-2 text-[12px] leading-relaxed text-text-secondary">
      <span
        aria-hidden
        className={cn(
          'mt-1.5 h-1 w-1 shrink-0 rounded-full',
          fixable ? 'bg-sla-warn' : 'bg-sla-breach',
        )}
      />
      <span>{text}</span>
    </li>
  );
}

/**
 * Emptying an organisation. The result is reported in two numbers rather than
 * one, because the second is a permission change nobody asked for: moving a
 * contact revokes their organisation reading, and an administrator who only
 * meant to tidy the directory has to be told they also took a right away.
 */
function ReassignContactsDialog({
  org,
  onClose,
  onDone,
}: {
  org: OrganizationRecord;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<string>('');
  const [working, setWorking] = useState(false);

  const { options: allOptions, truncated } = useOrganizationOptions(null, null);

  const options = useMemo(
    () => [
      { value: '', label: t('portalAdmin.noOrganization', 'No organisation') },
      // The source is excluded rather than merely refused: the server answers
      // 400 on a move into itself, and an option that can only fail is worse
      // than one that is not there.
      ...allOptions.filter((option) => option.value !== String(org.id)),
    ],
    [allOptions, org.id, t],
  );

  async function move() {
    setWorking(true);
    try {
      const result = await organizationsApi.reassignContacts(
        org.id,
        target === '' ? null : Number(target),
      );
      toast.success(
        result.visibilityRevoked > 0
          ? t(
              'portalAdmin.reassignedWithRevoke',
              '{{moved}} contacts moved. {{revoked}} of them lost the right to read this organisation tickets.',
              { moved: result.moved, revoked: result.visibilityRevoked },
            )
          : t('portalAdmin.reassigned', '{{moved}} contacts moved.', { moved: result.moved }),
      );
      await onDone();
    } catch (error) {
      toast.error(errorMessage(error, t('portalAdmin.reassignFailed', 'Could not move the contacts.')));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      closeLabel={t('common.close', 'Close')}
      title={t('portalAdmin.reassignTitle', 'Move every contact out of {{name}}', {
        name: org.name,
      })}
      subtitle={org.slug}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={working}
            icon={<ArrowRightLeft size={13} />}
            onClick={() => void move()}
          >
            {t('portalAdmin.reassignConfirm', 'Move them')}
          </Button>
        </>
      }
    >
      <div className="space-y-4 pb-2">
        <p className="text-[13px] leading-relaxed text-text-primary">
          {t(
            'portalAdmin.reassignLead',
            'All {{count}} contacts of {{name}} move at once. Their tickets do not move: those stay attached to {{name}}, which is what makes this the step before a delete rather than the delete itself.',
            { count: org.contactCount, name: org.name },
          )}
        </p>

        <Select
          label={t('portalAdmin.reassignTarget', 'Move them to')}
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          options={options}
          hint={
            truncated
              ? t(
                  'portalAdmin.pickerTruncated',
                  'Only the first {{count}} organisations are listed here.',
                  { count: PICKER_LIMIT },
                )
              : t(
                  'portalAdmin.reassignTargetHint',
                  'Choosing no organisation detaches them. They keep their sign-in and their own tickets.',
                )
          }
        />

        <p className="flex items-start gap-2 rounded-card bg-sla-warn-bg px-3 py-2 text-[12px] leading-relaxed text-sla-warn">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {t(
              'portalAdmin.reassignRevokeWarning',
              'Anyone who reads the whole of {{name}} loses that right in the move. It was granted against {{name}}, and carrying it to another customer would hand them a stranger ticket history.',
              { name: org.name },
            )}
          </span>
        </p>
      </div>
    </Modal>
  );
}

export default AdminPortalPage;
