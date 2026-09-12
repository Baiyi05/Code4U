import { cn } from '@/lib/utils';
import type { DemoMember } from '@/lib/demo-data';

/** Initials in a tinted circle. A prototype has no photos, and inventing them would not help. */
export function Avatar({
  member,
  size = 'default',
  className,
}: {
  member: Pick<DemoMember, 'displayName' | 'initials' | 'tint'>;
  size?: 'sm' | 'default';
  className?: string;
}) {
  return (
    <span
      title={member.displayName}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        size === 'sm' ? 'size-6 text-[0.625rem]' : 'size-8 text-xs',
        member.tint,
        className,
      )}
    >
      {member.initials}
    </span>
  );
}

export function AvatarRow({
  members,
  size = 'sm',
  className,
}: {
  members: ReadonlyArray<Pick<DemoMember, 'id' | 'displayName' | 'initials' | 'tint'>>;
  size?: 'sm' | 'default';
  className?: string;
}) {
  return (
    <span className={cn('flex -space-x-1.5', className)}>
      {members.map((member) => (
        <Avatar
          key={member.id}
          member={member}
          size={size}
          className="ring-2 ring-card"
        />
      ))}
    </span>
  );
}
