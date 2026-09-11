'use client';

import { ExternalLink } from 'lucide-react';

import type { SourceCitation } from '@/lib/schemas';

/**
 * "Why this" — the product's first principle made literal.
 *
 * A block that cannot say why it is on the plan should not be on the plan, and
 * the same goes for a replacement a re-plan proposes. Screen 05 renders this for
 * a block; the ADDED rows on screen 06 render it for a candidate, so the two
 * always look and read the same.
 *
 * 📖 SOURCE is only drawn when there is a retrieved chunk behind it. The empty
 * state says so rather than filling the row with something plausible.
 */
export interface WhyThis {
  budget?: string | null;
  votes?: string | null;
  constraint?: string | null;
  source?: SourceCitation | null;
}

export function WhyThisRows({
  why,
  compact = false,
  emptySource,
}: {
  why: WhyThis;
  /** tighter type and label column, for the diff rows */
  compact?: boolean;
  /** shown in place of the citation when nothing was retrieved; omit to hide the row */
  emptySource?: string;
}) {
  const labelWidth = compact ? 'w-[4.75rem]' : 'w-[5.5rem]';
  const text = compact ? 'text-xs' : 'text-sm';

  return (
    <dl className={compact ? 'space-y-2' : 'space-y-3'}>
      <Row label="CONSTRAINT" tone="text-added" value={why.constraint} width={labelWidth} text={text} />
      <Row label="BUDGET" tone="text-accent-ink" value={why.budget} width={labelWidth} text={text} />
      <Row label="VOTES" tone="text-moved" value={why.votes} width={labelWidth} text={text} />

      {why.source ? (
        <div className="rounded-xl border border-line bg-line-soft/60 p-3">
          <dt className="label-caps text-ink-faint">📖 Source</dt>
          <dd className="mt-1.5">
            <p className={`${text} leading-relaxed text-ink italic`}>“{why.source.text}”</p>
            <p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
              {why.source.source}
              {why.source.url ? (
                <a
                  href={why.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-accent underline underline-offset-2"
                >
                  open
                  <ExternalLink className="size-3" />
                </a>
              ) : null}
            </p>
          </dd>
        </div>
      ) : emptySource ? (
        <div className="rounded-xl border border-dashed border-line p-3">
          <dt className="label-caps text-ink-faint">📖 Source</dt>
          <dd className="mt-1 text-xs leading-relaxed text-ink-faint">{emptySource}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Row({
  label,
  value,
  tone,
  width,
  text,
}: {
  label: string;
  value: string | null | undefined;
  tone: string;
  width: string;
  text: string;
}) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <dt className={`label-caps shrink-0 pt-0.5 ${width} ${tone}`}>{label}</dt>
      <dd className={`flex-1 leading-relaxed text-ink ${text}`}>{value}</dd>
    </div>
  );
}
