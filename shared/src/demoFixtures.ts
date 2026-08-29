/**
 * Fixtures for the demonstration data set.
 *
 * They live in `shared` because BOTH sides seed: the setup wizard's step 6 does
 * it from the browser, and `DEMO_DATA=true` does it at server boot. Two copies
 * of this list would drift, and the drift would be invisible until somebody
 * compared two demo tenants and found different tickets.
 *
 * The subjects are deliberately a real week on a French service desk rather
 * than lorem. A demo you cannot read is a demo you cannot judge: the point of
 * seeding is to see whether the queue, the SLA chips, the grouping and the
 * collision bar behave, and none of that is visible against "Ticket 12".
 */

/** The tenant demo data lives in. Purging = deleting this tenant. */
export const DEMO_TENANT_SLUG = 'demo';
export const DEMO_TENANT_NAME = 'Démonstration';

/**
 * Marker written to `tenants.settings`. The purge refuses to delete a tenant
 * that does not carry it, so a real workspace someone happened to name "demo"
 * survives a `DEMO_DATA=false` boot.
 */
export const DEMO_TENANT_MARKER = 'isDemo';

export const DEMO_SUBJECTS: readonly string[] = [
  'Impossible de se connecter au VPN depuis ce matin',
  'Imprimante du 2e étage hors ligne',
  'Demande de création de compte pour une nouvelle arrivée',
  'Outlook se ferme tout seul après la mise à jour',
  'Accès refusé au partage Comptabilité',
  'Le Wi-Fi invité ne distribue plus d’adresse',
  'Téléphone IP muet en réception',
  'Mot de passe expiré, compte verrouillé',
  'Lenteur générale sur l’application de paie',
  'Écran secondaire non détecté sur la station 14',
  'Message de phishing reçu par trois collègues',
  'Sauvegarde du serveur de fichiers en échec cette nuit',
  'Demande de licence supplémentaire pour la CAO',
  'Badge d’accès désactivé après le déménagement',
  'Le scanner du service RH ne pousse plus vers le partage',
  'Disque presque plein sur le poste de la direction',
  'Deux factures identiques envoyées par le portail fournisseur',
  'Le portail client refuse les pièces jointes de plus de 5 Mo',
  'Demande de restauration d’un dossier supprimé mardi',
  'Poste bloqué sur une mise à jour Windows depuis 40 minutes',
  'La borne Wi-Fi du hall redémarre toutes les heures',
  'Impossible d’imprimer en recto-verso depuis la compta',
  'Le certificat du site vitrine expire dans huit jours',
  'Demande de matériel pour un poste de travail temporaire',
];

/** Requesters. Surnames only, so the set reads as a directory and not as people. */
export const DEMO_REQUESTERS: readonly { name: string; email: string }[] = [
  { name: 'Camille Berthier', email: 'c.berthier@demo.local' },
  { name: 'Julien Marchand', email: 'j.marchand@demo.local' },
  { name: 'Nadia Lefèvre', email: 'n.lefevre@demo.local' },
  { name: 'Thomas Ollivier', email: 't.ollivier@demo.local' },
  { name: 'Sarah Benali', email: 's.benali@demo.local' },
  { name: 'Marc Delaunay', email: 'm.delaunay@demo.local' },
  { name: 'Élodie Rousseau', email: 'e.rousseau@demo.local' },
  { name: 'Antoine Vasseur', email: 'a.vasseur@demo.local' },
];

export const DEMO_ORGANISATIONS: readonly string[] = [
  'Acme Industries',
  'Cabinet Vidal',
  'Groupe Lantier',
  'Mairie de Sainte-Foy',
];

/**
 * How the generated tickets spread across the lifecycle.
 *
 * Weighted so the demo looks like a working desk and not like a fresh install:
 * mostly open work, a visible pending-customer pile (which is what makes the
 * SLA pause legible), and enough resolved volume for the dashboard rollup to
 * have something to average.
 */
export const DEMO_STATUS_MIX: readonly { statusSlug: string; weight: number }[] = [
  { statusSlug: 'new', weight: 15 },
  { statusSlug: 'triage', weight: 10 },
  { statusSlug: 'in_progress', weight: 25 },
  { statusSlug: 'pending_requester', weight: 20 },
  { statusSlug: 'resolved', weight: 25 },
  { statusSlug: 'closed', weight: 5 },
];

export const DEMO_PRIORITY_MIX: readonly { prioritySlug: string; weight: number }[] = [
  { prioritySlug: 'p1', weight: 5 },
  { prioritySlug: 'p2', weight: 15 },
  { prioritySlug: 'p3', weight: 55 },
  { prioritySlug: 'p4', weight: 25 },
];

/** Replies an agent might actually type, for the tickets that get a journal. */
export const DEMO_REPLIES: readonly string[] = [
  'Bonjour, je prends en charge. Pouvez-vous me confirmer le nom du poste ?',
  'J’ai relancé le service, pouvez-vous retester de votre côté ?',
  'C’est bien un problème de droits. Je corrige et je reviens vers vous.',
  'Le correctif est déployé. Je laisse le ticket ouvert 24 h par sécurité.',
  'Merci pour la capture, elle confirme la piste. Intervention prévue demain matin.',
];

export const DEMO_WORK_NOTES: readonly string[] = [
  'Vu avec l’équipe réseau : la borne a été remplacée hier soir.',
  'À surveiller, troisième occurrence ce mois-ci sur le même poste.',
  'Le fournisseur a ouvert un ticket de leur côté, référence en attente.',
];

/** How far back the generated tickets are spread. */
export const DEMO_SPREAD_DAYS = 21;

/** Volume defaults. The wizard offers its own number; boot uses this. */
export const DEMO_DEFAULT_VOLUME = 60;
export const DEMO_MAX_VOLUME = 500;

/**
 * Deterministic pseudo-random, so two seedings of the same volume produce the
 * same demo. `Math.random()` would make "it looked different last time" a real
 * support question about the demo itself.
 */
export function demoRandom(seed: number): () => number {
  let value = seed >>> 0 || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    value >>>= 0;
    return value / 0x1_0000_0000;
  };
}

/** Pick from a weighted mix with a supplied random source. */
export function pickWeighted<T extends { weight: number }>(items: readonly T[], rnd: () => number): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rnd() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}
