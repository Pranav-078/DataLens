import { describe, expect, it } from "vitest";
import {
  applyRerankOrder,
  evaluateRetrieval,
  reciprocalRankFusion,
  splitTextIntoChunks,
  type RankedChunk,
} from "../src/modules/ai/rag.js";

function chunk(id: string, similarity: number | null = null, lexical_score: number | null = null): RankedChunk {
  return {
    id,
    document_id: "document-1",
    filename: "guide.md",
    chunk_index: Number(id.replace(/\D/g, "")) || 0,
    content: "Evidence for " + id,
    page_number: null,
    section_heading: "Data quality",
    similarity,
    lexical_score,
  };
}

describe("RAG chunking", () => {
  it("preserves markdown section headings and creates overlapping chunks", () => {
    const input = "# Customers\n" + "customer identifier and profile fields. ".repeat(12) +
      "\n\n## Orders\n" + "order amount and customer identifier. ".repeat(12);
    const chunks = splitTextIntoChunks(input, 240, 40);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0]?.sectionHeading).toBe("Customers");
    expect(chunks.some(item => item.sectionHeading === "Orders")).toBe(true);
    expect(chunks.every(item => item.content.length > 0)).toBe(true);
    expect(chunks.map(item => item.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it("returns no chunks for empty input and rejects invalid overlap", () => {
    expect(splitTextIntoChunks("  \n ")).toEqual([]);
    expect(() => splitTextIntoChunks("text", 120, 120)).toThrow();
  });
});

describe("hybrid rank fusion", () => {
  it("promotes candidates found by both vector and keyword retrieval", () => {
    const vector = [chunk("a", 0.91), chunk("b", 0.84)];
    const keyword = [chunk("b", null, 0.7), chunk("c", null, 0.4)];
    const result = reciprocalRankFusion(vector, keyword, 10);

    expect(result[0]?.id).toBe("b");
    expect(result.find(item => item.id === "b")?.vectorRank).toBe(2);
    expect(result.find(item => item.id === "b")?.keywordRank).toBe(1);
    expect(result).toHaveLength(3);
  });

  it("respects result limits", () => {
    expect(reciprocalRankFusion([chunk("a"), chunk("b")], [chunk("c")], 2)).toHaveLength(2);
  });
});

describe("safe reranking", () => {
  it("uses valid candidate IDs and keeps omitted candidates at the end", () => {
    const candidates = [chunk("a"), chunk("b"), chunk("c")];
    const result = applyRerankOrder(candidates, ["c", "not-a-candidate", "c", "a"]);

    expect(result.map(item => item.id)).toEqual(["c", "a", "b"]);
  });
});

describe("retrieval evaluation", () => {
  it("calculates precision, recall, reciprocal rank and nDCG", () => {
    const metrics = evaluateRetrieval(["irrelevant", "relevant-a", "irrelevant-2"], ["relevant-a", "relevant-b"], 3);

    expect(metrics.precisionAtK).toBeCloseTo(1 / 3);
    expect(metrics.recallAtK).toBeCloseTo(1 / 2);
    expect(metrics.reciprocalRank).toBeCloseTo(1 / 2);
    expect(metrics.ndcgAtK).toBeGreaterThan(0);
    expect(metrics.relevantRetrieved).toBe(1);
  });

  it("returns zero metrics when nothing relevant is retrieved", () => {
    const metrics = evaluateRetrieval(["a", "b"], ["c"], 2);
    expect(metrics.precisionAtK).toBe(0);
    expect(metrics.recallAtK).toBe(0);
    expect(metrics.reciprocalRank).toBe(0);
    expect(metrics.ndcgAtK).toBe(0);
  });
});
