function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function extractRetrievedDocIds(metadata?: Record<string, unknown>): string[] | undefined {
  if (!metadata) return undefined;

  const direct =
    stringArray(metadata.evidenceIds) ??
    stringArray(metadata.evidence_ids) ??
    stringArray(metadata.retrievedDocIds) ??
    stringArray(metadata.retrieved_doc_ids) ??
    stringArray(metadata.ragDocumentIds) ??
    stringArray(metadata.rag_document_ids);
  if (direct) return direct;

  const evidence = metadata.evidence;
  if (evidence && typeof evidence === "object") {
    const nested = evidence as Record<string, unknown>;
    const nestedEvidence = stringArray(nested.ids) ?? stringArray(nested.docIds) ?? stringArray(nested.documentIds);
    if (nestedEvidence) return nestedEvidence;
  }

  const retrieval = metadata.retrieval;
  if (retrieval && typeof retrieval === "object") {
    const nested = retrieval as Record<string, unknown>;
    return stringArray(nested.docIds) ?? stringArray(nested.documentIds) ?? stringArray(nested.retrievedDocIds);
  }

  return undefined;
}
