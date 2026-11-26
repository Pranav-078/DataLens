import type { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../db/prisma.js";
import { embedText, generateText } from "./gemini.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
export const documentUploadMiddleware = upload.single("file");
const chatSchema = z.object({
  question: z.string().trim().min(2).max(4000),
  sessionId: z.string().uuid().optional(),
  versionId: z.string().uuid().optional(),
});

function splitIntoChunks(text: string, maxChars = 1200, overlap = 180): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n", end);
      if (boundary > start + maxChars * 0.6) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export async function uploadKnowledgeDocument(req: Request, res: Response) {
  const file = req.file;
  const projectId = typeof req.body?.projectId === "string" ? req.body.projectId : "";
  if (!file || !projectId) {
    res.status(400).json({ error: { code: "INVALID_DOCUMENT_UPLOAD", message: "Provide projectId and a .txt or .md file." } });
    return;
  }
  if (!file.originalname.toLowerCase().endsWith(".txt") && !file.originalname.toLowerCase().endsWith(".md")) {
    res.status(415).json({ error: { code: "UNSUPPORTED_DOCUMENT_TYPE", message: "Only .txt and .md knowledge documents are currently supported." } });
    return;
  }
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) {
    res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." } });
    return;
  }
  const content = file.buffer.toString("utf8");
  if (!content.trim()) {
    res.status(400).json({ error: { code: "EMPTY_DOCUMENT", message: "The document contains no text." } });
    return;
  }

  const document = await prisma.document.create({ data: {
    projectId, filename: file.originalname, filePath: "database://document-chunks",
    mimeType: file.mimetype || "text/plain", fileSizeBytes: BigInt(file.size), status: "processing",
  } });
  try {
    const chunks = splitIntoChunks(content);
    for (let index = 0; index < chunks.length; index++) {
      const vector = await embedText(chunks[index]);
      const vectorLiteral = `[${vector.join(",")}]`;
      await prisma.$executeRaw`
        INSERT INTO document_chunks (id, document_id, chunk_index, content, token_count, embedding)
        VALUES (gen_random_uuid(), ${document.id}::uuid, ${index}, ${chunks[index]}, ${Math.ceil(chunks[index].length / 4)}, ${vectorLiteral}::vector)
      `;
    }
    await prisma.document.update({ where: { id: document.id }, data: { status: "ready", chunkCount: chunks.length } });
    res.status(201).json({ documentId: document.id, filename: document.filename, chunkCount: chunks.length, status: "ready" });
  } catch (error) {
    await prisma.document.update({ where: { id: document.id }, data: { status: "failed", errorMessage: error instanceof Error ? error.message : "Embedding failed" } });
    throw error;
  }
}

async function retrieveContext(projectId: string, question: string, limit = 5) {
  const vector = await embedText(question);
  const vectorLiteral = `[${vector.join(",")}]`;
  return prisma.$queryRaw<Array<{ document_id: string; filename: string; chunk_index: number; content: string; similarity: number }>>`
    SELECT dc.document_id, d.filename, dc.chunk_index, dc.content,
           1 - (dc.embedding <=> ${vectorLiteral}::vector) AS similarity
    FROM document_chunks dc
    JOIN documents d ON d.id = dc.document_id
    WHERE d.project_id = ${projectId}::uuid AND d.status = 'ready' AND dc.embedding IS NOT NULL
    ORDER BY dc.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;
}

async function runAgentTool(tool: string, projectId: string, versionId?: string) {
  if (!versionId) return { message: "No dataset version is selected. Ask the user to upload or select a version." };
  const version = await prisma.datasetVersion.findFirst({ where: { id: versionId, projectId }, select: { id: true } });
  if (!version) return { message: "The selected dataset version does not belong to this project." };
  if (tool === "quality_issues") {
    const issues = await prisma.qualityIssue.findMany({ where: { versionId }, take: 30,
      select: { issueType: true, dimension: true, severity: true, title: true, description: true, affectedRows: true, totalRows: true, affectedPercentage: true, suggestedAction: true } });
    return { tool, count: issues.length, issues };
  }
  if (tool === "schema") {
    const tables = await prisma.datasetTable.findMany({ where: { versionId }, select: { tableName: true, rowCount: true, columnCount: true, columns: { select: { columnName: true, inferredType: true } } } });
    return { tool, tables };
  }
  if (tool === "relationships") {
    const relationships = await prisma.inferredRelationship.findMany({ where: { versionId }, take: 50,
      select: { confidence: true, confidenceBand: true, parentTable: { select: { tableName: true } }, parentColumn: { select: { columnName: true } }, childTable: { select: { tableName: true } }, childColumn: { select: { columnName: true } }, orphanCount: true, orphanPercentage: true } });
    return { tool, relationships };
  }
  if (tool === "quality_score") {
    return { tool, score: await prisma.qualityScore.findUnique({ where: { versionId } }) };
  }
  return { message: "No matching DataLens tool was selected." };
}

export async function postAiChat(req: Request, res: Response) {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_CHAT_REQUEST", message: parsed.error.issues[0]?.message || "Invalid request." } });
    return;
  }
  const { question, versionId } = parsed.data;
  const projectId = req.params.projectId;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) {
    res.status(404).json({ error: { code: "PROJECT_NOT_FOUND", message: "Project was not found." } });
    return;
  }
  const session = parsed.data.sessionId
    ? await prisma.chatSession.findFirst({ where: { id: parsed.data.sessionId, projectId } })
    : await prisma.chatSession.create({ data: { projectId, title: question.slice(0, 80) } });
  if (!session) {
    res.status(404).json({ error: { code: "CHAT_SESSION_NOT_FOUND", message: "Chat session was not found in this project." } });
    return;
  }

  const retrieved = await retrieveContext(projectId, question);
  const planner = await generateText(`You are the tool planner for DataLens, a data quality assistant. Select at most one tool and return ONLY JSON: {"tool":"quality_issues|schema|relationships|quality_score|none","reason":"short reason"}. Use quality_issues for defect questions, schema for table/column questions, relationships for join/key questions, quality_score for score questions, otherwise none. User question: ${question}`);
  let toolChoice = "none";
  try {
    const match = planner.match(/\{[\s\S]*\}/);
    const candidate = match ? JSON.parse(match[0]) : {};
    if (["quality_issues", "schema", "relationships", "quality_score"].includes(candidate.tool)) toolChoice = candidate.tool;
  } catch { toolChoice = "none"; }
  const toolResult = await runAgentTool(toolChoice, projectId, versionId);
  const context = retrieved.map((item, i) => `[D${i + 1}] ${item.filename} (chunk ${item.chunk_index + 1}, similarity ${Number(item.similarity).toFixed(3)}):\n${item.content}`).join("\n\n");
  const answer = await generateText(`You are DataLens, an evidence-grounded data quality assistant. Answer the user clearly. Use only the supplied dataset tool output and retrieved document context for factual claims about this project. If evidence is missing, say so. Cite retrieved document passages using [D1], [D2]. Never claim a data change was performed.\n\nQuestion: ${question}\n\nSelected tool: ${toolChoice}\nTool output (JSON): ${JSON.stringify(toolResult)}\n\nRetrieved knowledge: ${context || "No relevant project documents were found."}`);
  const userMessage = await prisma.chatMessage.create({ data: { sessionId: session.id, role: "user", content: question, retrievedChunkIds: [], retrievalScores: [] } });
  const assistantMessage = await prisma.chatMessage.create({ data: {
    sessionId: session.id, role: "assistant", content: answer,
    retrievedChunkIds: retrieved.map((item: any) => `${item.document_id}:${item.chunk_index}`),
    retrievalScores: retrieved.map((item: any) => Number(item.similarity)), latencyMs: null,
  } });
  res.status(200).json({ sessionId: session.id, userMessageId: userMessage.id, messageId: assistantMessage.id, answer, toolUsed: toolChoice,
    sources: retrieved.map((item: any, i: number) => ({ citation: `D${i + 1}`, filename: item.filename, chunkIndex: item.chunk_index, similarity: Number(item.similarity) })) });
}
