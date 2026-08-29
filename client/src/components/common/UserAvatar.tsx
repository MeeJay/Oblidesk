import { cn } from '@/utils/cn';

interface UserAvatarProps {
  /** Profile photo URL or data URI, synced from Obligate. Null renders the initial fallback. */
  avatar?: string | null;
  /** Username or display name — drives the initial letter and the hue. */
  username?: string | null;
  /** Pixel size; the component is always a circle. */
  size?: number;
  /** Small dot in the bottom-right corner — agent presence on a ticket. */
  presence?: 'online' | 'away' | 'offline' | null;
  className?: string;
  title?: string;
}

/**
 * Round avatar — the image when Obligate has one, an accent-tinted circle with
 * the first letter otherwise. Same visual the rest of the Obli suite uses so a
 * user without a photo looks identical across apps.
 *
 * The fallback hue is derived from the name so two agents in the same collision
 * bar are told apart at a glance, while staying inside the Oblidesk cyan family
 * (hue 196 ± 40) instead of turning the header into a fruit salad.
 */
export function UserAvatar({
  avatar,
  username,
  size = 26,
  presence = null,
  className,
  title,
}: UserAvatarProps) {
  const clean = (username ?? '').startsWith('og_') ? (username ?? '').slice(3) : username ?? '';
  const initial = (clean || '?').charAt(0).toUpperCase();
  const dim = `${size}px`;
  const fontSize = `${Math.max(9, Math.round(size * 0.42))}px`;

  // Deterministic hue in the cyan neighbourhood — stable across reloads.
  let hash = 0;
  for (let i = 0; i < clean.length; i += 1) hash = (hash * 31 + clean.charCodeAt(i)) % 360;
  const hue = 196 + ((hash % 80) - 40);

  const dot =
    presence === 'online'
      ? 'bg-status-resolved'
      : presence === 'away'
        ? 'bg-sla-warn'
        : 'bg-status-closed';

  const inner = avatar ? (
    <img
      src={avatar}
      alt={clean || 'avatar'}
      className="h-full w-full rounded-full object-cover"
      style={{ width: dim, height: dim }}
    />
  ) : (
    <span
      className="flex h-full w-full items-center justify-center rounded-full font-semibold text-white"
      style={{
        fontSize,
        background: `linear-gradient(135deg, hsl(${hue} 88% 58% / 0.85), hsl(${hue - 20} 78% 40% / 0.85))`,
      }}
    >
      {initial}
    </span>
  );

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: dim, height: dim }}
      title={title ?? (clean || undefined)}
    >
      {inner}
      {presence && (
        <span
          className={cn(
            'absolute bottom-0 right-0 rounded-full ring-2 ring-bg-secondary',
            dot,
          )}
          style={{ width: Math.max(6, size * 0.28), height: Math.max(6, size * 0.28) }}
        />
      )}
    </span>
  );
}
