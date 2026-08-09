const fs = require("fs");
const path = require("path");

const providers = [
  { name: "lance", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "chroma", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "pinecone", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "qdrant", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "weaviate", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "pgvector", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "milvus", embeddedVectorId: "vectorId: vectorRecord.id" },
  { name: "astra", embeddedVectorId: "vectorId: vectorRecord._id" },
];

describe.each(providers)("$name chunk position contract", (provider) => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      "../../../utils/vectorDbProviders",
      provider.name,
      "index.js"
    ),
    "utf8"
  );

  it("records complete position metadata for cache and embedding paths", () => {
    expect(source).toContain("const cachedChunks = chunks.flat();");
    expect(source).toContain("chunkCount: cachedChunks.length");
    expect(source).toContain("chunkCount: textChunks.length");
    expect(source).toContain(provider.embeddedVectorId);
    expect(source.match(/documentVectors\.push\(\{/g)).toHaveLength(2);
    expect(source.match(/chunkIndex:/g).length).toBeGreaterThanOrEqual(2);
    expect(source.match(/chunkText:/g).length).toBeGreaterThanOrEqual(2);
  });
});
