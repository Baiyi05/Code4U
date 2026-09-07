'use client';

import * as LabelPrimitive from '@radix-ui/react-label';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import * as SeparatorPrimitive from '@radix-ui/react-separator';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm leading-none font-medium text-ink select-none', className)}
      {...props}
    />
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink outline-none transition-[border-color,box-shadow]',
        'placeholder:text-ink-faint focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/25',
        className,
      )}
      {...props}
    />
  );
}

export function Separator({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      orientation={orientation}
      className={cn(
        'shrink-0 bg-line',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}

/** A radio group rendered as full-width option cards — the questionnaire's whole UI. */
export const OptionGroup = RadioGroupPrimitive.Root;

export function Option({
  className,
  title,
  hint,
  value,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item> & { title: string; hint?: string }) {
  return (
    <RadioGroupPrimitive.Item
      value={value}
      className={cn(
        'group flex w-full items-start gap-3 rounded-xl border border-line bg-card p-4 text-left outline-none transition-all',
        'hover:border-ink-faint focus-visible:ring-2 focus-visible:ring-accent/40',
        'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft/60 data-[state=checked]:shadow-[0_0_0_1px_var(--color-accent)]',
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-line bg-card transition-colors group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent">
        <span className="size-2 rounded-full bg-transparent transition-colors group-data-[state=checked]:bg-white" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">{title}</span>
        {hint ? <span className="mt-0.5 block text-xs text-ink-soft">{hint}</span> : null}
      </span>
    </RadioGroupPrimitive.Item>
  );
}

/** A multi-select chip. Cheaper than a checkbox group and reads better on a phone. */
export function Chip({
  className,
  selected = false,
  ...props
}: ComponentProps<'button'> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'rounded-full border px-3.5 py-2 text-sm transition-all active:scale-[0.97]',
        selected
          ? 'border-accent bg-accent-soft text-accent-ink shadow-[0_0_0_1px_var(--color-accent)]'
          : 'border-line bg-card text-ink-soft hover:border-ink-faint hover:text-ink',
        className,
      )}
      {...props}
    />
  );
}
