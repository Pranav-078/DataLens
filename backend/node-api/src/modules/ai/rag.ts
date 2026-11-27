export interface TextChunk {
  chunkIndex: number;
  content: string;
  sectionHeading: string | null;
  pageNumber: number | null;
}

export interface RankedChunk {
  id: string;
  document_id: string;
  filename: string;
  chunk_index: number;
  content: string;
  page_number: number | null;
  section_heading: string | null;
  similarity?: number | null;
  lexical_score?: number | null;
  vectorRank?: number;
  keywordRank?: number;
  fusionScore?: number;
}

export interface RetrievalEvaluation {
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  relevantRetrieved: number;
  retrieved: number;
}

/**
 * Split text on paragraph/line boundaries where possible. Markdown headings
 * are carried into chunk metadata so retrieved evidence can be located later.
 * PDF extraction currently returns a text stream, so pageNumber remains null
 * until a page-aware PDF parser is introduced.
 */
export function splitTextIntoChunks(
  input: string,
  maxChars = 1200,
  overlap = 180
): TextChunk[] {
  const normalized = input.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  if (!Number.isInteger(maxChars) || maxChars < 100) throw new Error("maxChars must be at least 100.");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChars) throw new Error("overlap must be between 0 and maxChars.");

  const headings = Array.from(normalized.matchAll(/^#{1,6}\s+(.+)$/gm)).map(match => ({
    position: match.index ?? 0,
    heading: (match[1] ?? "").trim(),
  }));

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + maxChars * 0.6) end = boundary;
      else {
        const paragraphBoundary = normalized.lastIndexOf("\n\n", end);
        if (paragraphBoundary > start + maxChars * 0.5) end = paragraphBoundary;
      }
    }

    const content = normalized.slice(start, end).trim();
    if (content) {
      let sectionHeading: string | null = null;
      for (const heading of headings) {
        if (heading.position > start) break;
        sectionHeading = heading.heading;
      }
      chunks.push({
        chunkIndex: chunks.length,
        content,
        sectionHeading,
        pageNumber: null,
      });
    }

    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

/**
 * Reciprocal Rank Fusion (RRF) merges independent vector and full-text ranks
 * without pretending that cosine similarity and ts_rank are the same scale.
 */
export function reciprocalRankFusion(
  vectorResults: RankedChunk[],
  keywordResults: RankedChunk[],
  limit = 15,
  rrfK = 60
): RankedChunk[] {
  const byId = new Map<string, RankedChunk>();

  vectorResults.forEach((item, index) => {
    const current = byId.get(item.id) ?? { ...item, fusionScore: 0 };
    current.vectorRank = index + 1;
    current.similarity = item.similarity ?? null;
    current.fusionScore = (current.fusionScore ?? 0) + 1 / (rrfK + index + 1);
    byId.set(item.id, current);
  });

  keywordResults.forEach((item, index) => {
    const current = byId.get(item.id) ?? { ...item, fusionScore: 0 };
    current.keywordRank = index + 1;
    current.lexical_score = item.lexical_score ?? null;
    current.fusionScore = (current.fusionScore ?? 0) + 1 / (rrfK + index + 1);
    byId.set(item.id, current);
  });

  return Array.from(byId.values())
    .sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0))
    .slice(0, limit);
}

/** Validate a model-produced rerank order against known candidate IDs. */
export function applyRerankOrder<T extends { id: string }>(
  candidates: T[],
  rankingIds: string[]
): T[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const seen = new Set<string>();
  const ordered: T[] = [];

  for (const id of rankingIds) {
    const candidate = byId.get(id);
    if (candidate && !seen.has(id)) {
      ordered.push(candidate);
      seen.add(id);
    }
  }
  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) ordered.push(candidate);
  }
  return ordered;
}

export function evaluateRetrieval(
  retrievedIds: string[],
  relevantIds: string[],
  k = 5
): RetrievalEvaluation {
  const relevant = new Set(relevantIds);
  const window = retrievedIds.slice(0, Math.max(0, k));
  const hits = window.filter(id => relevant.has(id));
  const firstRelevantIndex = window.findIndex(id => relevant.has(id));

  const dcg = window.reduce((sum, id, index) =>
    sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  const idealHits = Math.min(relevant.size, window.length);
  const idealDcg = Array.from({ length: idealHits }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);

  return {
    precisionAtK: k > 0 ? hits.length / k : 0,
    recallAtK: relevant.size ? hits.length / relevant.size : 0,
    reciprocalRank: firstRelevantIndex >= 0 ? 1 / (firstRelevantIndex + 1) : 0,
    ndcgAtK: idealDcg > 0 ? dcg / idealDcg : 0,
    relevantRetrieved: hits.length,
    retrieved: window.length,
  };
}
