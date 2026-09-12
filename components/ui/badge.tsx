import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tracking-[0.04em] whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-line-soft text-ink-soft',
        outline: 'border border-line text-ink-soft',
        accent: 'bg-accent-soft text-accent-ink',
        removed: 'bg-removed-soft text-removed',
        moved: 'bg-moved-soft text-moved',
        added: 'bg-added-soft text-added',
        kept: 'bg-kept-soft text-kept',
        warn: 'bg-warn-soft text-warn',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
