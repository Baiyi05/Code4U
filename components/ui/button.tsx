'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] outline-none disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-[0.985] [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-ink text-paper hover:bg-ink/90',
        accent: 'bg-accent text-white hover:bg-accent-ink shadow-sm',
        outline: 'border border-line bg-card text-ink hover:bg-line-soft',
        ghost: 'text-ink-soft hover:bg-line-soft hover:text-ink',
        soft: 'bg-line-soft text-ink hover:bg-line',
        danger: 'bg-removed-soft text-removed hover:bg-removed hover:text-white',
      },
      size: {
        sm: 'h-8 px-3 text-[0.8125rem]',
        default: 'h-10 px-4',
        lg: 'h-12 px-6 text-base',
        icon: 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
