import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui's class merger. UI only — the engines in lib/ do not use it. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
