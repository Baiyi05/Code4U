/**
 * lib/__mocks__/knowledge.ts — L2 Taste without pgvector.
 *
 * A fixed handful of Osaka chunks with real sources, ranked by a plain keyword
 * overlap instead of a cosine distance. Enough to prove that citations flow from
 * retrieval through the prompt and into block.sourceCitation.
 *
 * The real retriever — embed the query, call match_knowledge() — is the AI role's job.
 */

import type { KnowledgeRetriever } from '../generate';
import type { KnowledgeChunk } from '../schemas';

/**
 * Deliberately short and factual. These stand in for retrieved corpus text, so
 * they say only things that are plainly true of the places involved.
 */
export const MOCK_CHUNKS: readonly KnowledgeChunk[] = [
  {
    chunk: 'Osaka Castle sits in a public park; the keep charges admission but the grounds do not.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'chuo',
    tags: ['history', 'castles', 'sight'],
  },
  {
    chunk: 'Dotonbori runs along the canal and is busiest after dark, when the signage is lit.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'namba',
    tags: ['street food', 'nightlife'],
  },
  {
    chunk: 'The bay area around Kaiyukan is reached on the Chuo subway line, then a short walk.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'bay',
    tags: ['sight', 'views'],
  },
  {
    chunk: 'Universal Studios Japan allows same-day re-entry, so lunch can be taken outside the park.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'konohana',
    tags: ['theme parks'],
  },
  {
    chunk: 'Tenjinbashisuji is the longest covered shopping street in Japan and is cheap to eat on.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'kita',
    tags: ['street food', 'shopping'],
  },
  {
    chunk: 'Osaka has a long-standing vegetarian and halal scene around Namba and Nipponbashi.',
    source: 'Wikivoyage / Osaka',
    url: 'https://en.wikivoyage.org/wiki/Osaka',
    district: 'namba',
    tags: ['vegetarian', 'no pork', 'food'],
  },
];

function score(chunk: KnowledgeChunk, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let hits = 0;
  if (chunk.chunk.toLowerCase().includes(needle)) hits += 2;
  for (const tag of chunk.tags ?? []) {
    if (tag.toLowerCase() === needle) hits += 3;
    else if (tag.toLowerCase().includes(needle) || needle.includes(tag.toLowerCase())) hits += 1;
  }
  return hits;
}

export class MockKnowledgeRetriever implements KnowledgeRetriever {
  /** Every search it was asked to run, in order. */
  readonly queries: Array<{ query: string; cityKey: string; k: number }> = [];

  private readonly chunks: readonly KnowledgeChunk[];

  constructor(chunks: readonly KnowledgeChunk[] = MOCK_CHUNKS) {
    this.chunks = chunks;
  }

  async search(query: string, cityKey: string, k: number): Promise<KnowledgeChunk[]> {
    this.queries.push({ query, cityKey, k });

    const ranked = this.chunks
      .map((chunk) => ({ chunk, hits: score(chunk, query) }))
      .filter((r) => r.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, k)
      .map((r) => ({ ...r.chunk, similarity: Math.min(1, 0.5 + r.hits / 10) }));

    // A real retriever returns its top k whether or not they are a good match,
    // so never come back empty-handed.
    return ranked.length > 0 ? ranked : this.chunks.slice(0, Math.min(k, 2)).map((c) => ({ ...c }));
  }
}
