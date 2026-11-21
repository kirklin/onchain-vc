import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * Keyword search over Monad's developer documentation, for the technology partner. The
 * documentation is fetched from the site the first time it is needed and kept in web/.data,
 * so it is read again only after that file is deleted.
 */

const SOURCE = "https://docs.monad.xyz/llms-full.txt";
const CACHE = path.join(process.cwd(), ".data", "monad-docs", "llms-full.txt");
const MAX_CHUNK = 1600;
const WORD = /[a-z0-9_]+/g;
const PAGE_START = /^# (.+)\nSource: (\S+)$/gm;
const SECTION_START = /^## .+$/gm;

export interface DocChunk {
  title: string;
  url: string;
  text: string;
}

export interface DocIndex {
  chunks: DocChunk[];
  terms: Map<string, number>[];
  lengths: number[];
  averageLength: number;
  documentFrequency: Map<string, number>;
}

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

/** Splits the file into pages, each starting with `# Title` and a `Source:` line, then into sections. */
export function chunkDocs(full: string): DocChunk[] {
  const starts = [...full.matchAll(PAGE_START)];
  const chunks: DocChunk[] = [];
  starts.forEach((match, index) => {
    const body = full.slice(match.index + match[0].length, starts[index + 1]?.index ?? full.length).trim();
    const sections = body.split(SECTION_START).length > 1
      ? splitKeepingHeadings(body)
      : [body];
    for (const section of sections) {
      for (let offset = 0; offset < section.length; offset += MAX_CHUNK) {
        const text = section.slice(offset, offset + MAX_CHUNK).trim();
        if (text !== "") {
          chunks.push({ title: match[1]!, url: match[2]!, text });
        }
      }
    }
  });
  return chunks;
}

function splitKeepingHeadings(body: string): string[] {
  const headings = [...body.matchAll(SECTION_START)];
  const parts = [body.slice(0, headings[0]!.index)];
  headings.forEach((heading, index) => {
    parts.push(body.slice(heading.index, headings[index + 1]?.index ?? body.length));
  });
  return parts.filter(part => part.trim() !== "");
}

export function indexDocs(chunks: DocChunk[]): DocIndex {
  const terms = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const word of words(`${chunk.title} ${chunk.text}`)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    return counts;
  });
  const lengths = terms.map(counts => [...counts.values()].reduce((sum, count) => sum + count, 0));
  const documentFrequency = new Map<string, number>();
  for (const counts of terms) {
    for (const word of counts.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  return { chunks, terms, lengths, averageLength: lengths.reduce((sum, length) => sum + length, 0) / Math.max(1, lengths.length), documentFrequency };
}

/** Ranks chunks by BM25 against the query's words, best first. */
export function searchIndex(index: DocIndex, query: string, limit: number): DocChunk[] {
  const k1 = 1.2;
  const b = 0.75;
  const total = index.chunks.length;
  const queryWords = [...new Set(words(query))];
  return index.chunks
    .map((chunk, position) => {
      let score = 0;
      for (const word of queryWords) {
        const frequency = index.terms[position]!.get(word) ?? 0;
        if (frequency === 0) {
          continue;
        }
        const containing = index.documentFrequency.get(word)!;
        const idf = Math.log(1 + (total - containing + 0.5) / (containing + 0.5));
        score += idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * index.lengths[position]! / index.averageLength));
      }
      return { chunk, score };
    })
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(entry => entry.chunk);
}

async function loadText(): Promise<string> {
  try {
    return await readFile(CACHE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const response = await fetch(SOURCE, { headers: { "user-agent": "onchain-vc" } });
  if (!response.ok) {
    throw new Error(`${SOURCE} answered HTTP ${response.status}.`);
  }
  const text = await response.text();
  await mkdir(path.dirname(CACHE), { recursive: true });
  await writeFile(CACHE, text);
  return text;
}

// One index per process. Stored on globalThis so dev-server reloads keep it.
const holder = globalThis as typeof globalThis & { onchainVcDocs?: Promise<DocIndex> };

export async function searchMonadDocs(query: string, limit = 3): Promise<DocChunk[]> {
  holder.onchainVcDocs ??= loadText().then(text => indexDocs(chunkDocs(text)));
  // A failed download is not kept, so the next search tries again.
  holder.onchainVcDocs.catch(() => {
    holder.onchainVcDocs = undefined;
  });
  return searchIndex(await holder.onchainVcDocs, query, limit);
}
