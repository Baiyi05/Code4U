'use client';

import { ImageOff } from 'lucide-react';
import { useState } from 'react';

import { thumbAt, type PlaceMedia } from '@/lib/demo-data';
import { cn } from '@/lib/utils';

/**
 * A Wikimedia Commons photo of a place.
 *
 * Two things it has to get right. The photos are CC licensed, so the credit
 * travels with the image wherever it is shown at size — `credit` draws the
 * photographer, the licence and a link back to the file page. And the demo may
 * be run on conference wifi, so a failed load falls back to a tinted tile
 * instead of a broken-image icon and a collapsed layout.
 */
export function PlaceImage({
  media,
  alt,
  width,
  className,
  rounded = 'rounded-lg',
}: {
  media: PlaceMedia | undefined;
  alt: string;
  /** the Commons thumbnail width to request; keep it close to the rendered size */
  width: number;
  className?: string;
  rounded?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = media ? thumbAt(media.imageUrl, width) : null;

  if (!src || failed) {
    return (
      <div
        className={cn(
          'flex items-center justify-center bg-line-soft text-ink-faint',
          rounded,
          className,
        )}
        aria-hidden
      >
        <ImageOff className="size-4 opacity-60" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- external CC images, no optimizer in a static prototype
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn('bg-line-soft object-cover', rounded, className)}
    />
  );
}

/** The attribution line. Required by the licence wherever the photo is shown at size. */
export function PhotoCredit({ media, className }: { media: PlaceMedia | undefined; className?: string }) {
  if (!media) return null;
  return (
    <p className={cn('text-[0.6875rem] leading-relaxed text-ink-faint', className)}>
      Photo: {media.artist ?? 'unknown'} · {media.license} ·{' '}
      <a
        href={media.fileUrl}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-ink-soft"
      >
        Wikimedia Commons
      </a>
    </p>
  );
}
