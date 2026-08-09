---
name: anythingllm-notebook-retrieval
description: "Search local AnythingLLM workspaces and retrieve source-backed passages with optional ordered preceding and following chunks. Use when Codex needs to list local notebooks, search a named AnythingLLM knowledge base, inspect vector-result positions, or expand selected hits for surrounding context. Do not use for web search, document ingestion, reindexing, direct database access, or requests unrelated to the local AnythingLLM corpus."
---

# AnythingLLM Notebook Retrieval

Use the AnythingLLM MCP tools as read-only retrieval primitives. Search first,
then expand only the hits needed to answer the request.

## Required tools

Use these MCP tools:

- anythingllm_list_notebooks
- anythingllm_search_notebook
- anythingllm_read_chunk_context

If the tools are unavailable, state that the anythingllm_local MCP dependency is
not connected. Do not fall back to reading SQLite, LanceDB, vector-cache, or
AnythingLLM storage directly.

## Retrieval workflow

1. Resolve the notebook.
   - Use the user-provided slug when available.
   - Use the user-provided exact name otherwise.
   - Call anythingllm_list_notebooks when the notebook is omitted or unclear.
   - Never guess between duplicate names; request or use a unique slug.
2. Search before expanding.
   - Call anythingllm_search_notebook with a concise evidence-oriented query.
   - Default to topK 8 and scoreThreshold 0.25 unless the request calls for
     different recall.
   - Preserve each hit's vectorId, score, document metadata, and position.
   - If results are empty or clearly off-topic, reformulate once. Lower the
     threshold only when broader recall is justified, and treat weak matches
     cautiously.
3. Select hits for context.
   - Do not expand every hit automatically.
   - First test whether the current hit already provides the minimum sufficient
     evidence for the question: the relevant entity, fact or value, scope, and
     material qualifiers.
   - Do not expand solely because fixed-size chunking starts or ends mid-sentence,
     cuts a table, or begins at a non-initial numbered item. Treat these only as
     clues that useful context may exist.
   - Expand only when both conditions hold: the current hits leave a concrete
     answer-relevant uncertainty, and an adjacent chunk is reasonably likely to
     resolve it. Base this prediction on the question and the retrieved text.
   - Skip expansion when a requested fact is already explicit and unambiguous,
     even if the chunk boundary is visibly truncated.
   - Expand in the likely useful direction when completeness matters or when a
     missing header, unit, definition, antecedent, qualifier, footnote, or
     numbered item could materially change the answer.
   - Respect a user request to stop after search and wait before reading context.
   - Prefer the strongest diverse hits; normally expand no more than three.
4. Read bounded context.
   - Choose the smallest useful direction and range. Read only preceding or only
     following chunks when their likely value is clear.
   - When both directions are plausibly useful or the direction is genuinely
     uncertain, default to before 2 and after 2.
   - Keep both values within 0 through 10.
   - Increase the range only when the user requests more context or the initial
     expansion remains incomplete.
   - Never request an entire document by default.
5. Merge evidence.
   - Group expanded chunks by document.
   - Order chunks by chunkIndex.
   - Deduplicate by vectorId.
   - Merge overlapping ranges from the same document without repeating text.
   - Keep different documents separate even when their language is similar.
6. Answer from retrieved evidence.
   - Lead with the answer, then cite the supporting document and chunk position.
   - Preserve material qualifiers and distinguish retrieval from inference.
   - Mention weak or conflicting evidence explicitly.
   - Do not expose embedding vectors or API credentials.

## Error handling

- For NOTEBOOK_NOT_FOUND, list available notebooks or ask for the intended one.
- For AMBIGUOUS_NOTEBOOK, present the candidate slugs and do not choose silently.
- For CHUNK_POSITION_UNAVAILABLE, state that the document must be reindexed;
  never infer neighboring chunks from IDs or cache order.
- For HTTP 403 or a missing-key error, state that ANYTHINGLLM_API_KEY is not
  available to the MCP process.
- For connection errors, verify that local AnythingLLM is running before
  changing retrieval parameters.

## Scope and privacy

Treat all tools as read-only. Keep retrieval within the requested Workspace.
Return only the evidence needed for the task, and never print, persist, or ask
the user to paste the API key into a document or source file.
