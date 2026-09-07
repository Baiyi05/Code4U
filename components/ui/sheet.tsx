'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * A bottom sheet on a phone, a right-hand panel on a laptop.
 *
 * Used only where the desktop layout does not already have room for the content
 * inline — the Block Detail screen renders the same component in a column on
 * md and up, and only falls back to this below it.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

export function SheetContent({
  className,
  children,
  title,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content> & { title: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/25 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
      <DialogPrimitive.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col overflow-hidden rounded-t-2xl border-t border-line bg-card shadow-2xl',
          'data-[state=open]:animate-sheet-up',
          'sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:max-h-none sm:w-[26rem] sm:rounded-none sm:rounded-l-2xl sm:border-t-0 sm:border-l',
          className,
        )}
        {...props}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-line sm:hidden" />
        <DialogPrimitive.Close className="absolute top-3 right-3 z-10 rounded-full p-1.5 text-ink-faint transition-colors hover:bg-line-soft hover:text-ink">
          <X className="size-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
