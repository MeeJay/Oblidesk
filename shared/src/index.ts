/**
 * @oblidesk/shared — the contract between the Oblidesk server and client.
 *
 * Build order matters: this package must be compiled BEFORE the server
 * (`cd shared && npx tsc`). The server resolves it through the npm-workspaces
 * symlink to `dist/`, so a stale `dist/` shows up as phantom type errors.
 * The client resolves it through a Vite alias straight to `src/`, so the
 * client sees changes without a rebuild — do not let that lull you into
 * forgetting the server side.
 *
 * Ordering below is dependency order, not alphabetical: modules with no local
 * imports come first, so a reader can follow the graph top to bottom.
 */

// ── Leaves: no intra-package dependencies ───────────────────────────────────
export * from './constants';
export * from './statusCategories';
export * from './capabilities';
export * from './calendar';
export * from './conditions';
export * from './themes';
export * from './demoFixtures';

// ── Config body shapes (depends on conditions, statusCategories, calendar) ──
export * from './configKinds';

// ── Problem management (depends on capabilities, statusCategories, configKinds)
// Placed BEFORE ./types on purpose: it is a leaf of the DTO graph. It declares
// its own slim `ProblemTicketHeader` rather than importing `Ticket`, so the
// shared evaluators (HARD RULE 12) stay importable from the client without
// dragging the whole DTO surface behind them.
export * from './problem';

// ── DTOs and wire types (depends on everything above) ───────────────────────
// NOTE: `ApprovalMode` is declared once, in ./configKinds, and re-exported by
// ./types — so this star export is unambiguous. If you add a symbol to
// ./types that already exists upstream, TypeScript will fail this barrel
// rather than silently pick one. Resolve it upstream, never by aliasing here.
export * from './types';
