/**
 * LangGraph Worker - RAG Pipeline
 * Handles embedding, retrieval, filtering, and summarization
 */

import * as dotenv from 'dotenv';
import OpenAI from 'openai';
import { ChromaClient, ChromaClientParams } from 'chromadb';
import * as path from 'path';
import { homedir } from 'os';

// Import chroma client fallback
let InMemoryChromaClient: any;
let indexStickiesFn: undefined | ((opts?: any) => Promise<any>);

let ChromaClientCtor: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ChromaClientCtor = require('chromadb').ChromaClient;
} catch {}

// Async import of chroma-indexer
async function loadChromaIndexer() {
  const candidates = [
    // Built JS output (preferred if present)
    path.resolve(__dirname, '../../chroma-indexer/dist/index.js'),
    // JS emitted in dev tree
    path.resolve(__dirname, '../../chroma-indexer/src/index.js'),
    // Raw TS source – will require ts-node
    path.resolve(__dirname, '../../chroma-indexer/src/index.ts'),
  ];

  for (const p of candidates) {
    try {
      if (!require('fs').existsSync(p)) continue;

      // Register ts-node on demand so that require() can handle TS files
      if (p.endsWith('.ts')) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('ts-node/register');
      }

      let chromaIndexer: any | undefined;

      /*
       * CommonJS (ts-node/register) path
       * ---------------------------------
       * When the worker is executed through ts-node, the module system is CJS.
       * In that case `await import()` is transpiled to `require()` internally,
       * but the generated specifier still contains the `file://` protocol which
       * `require()` cannot resolve. We therefore try a plain `require(p)` first.
       */
      if (typeof require === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          chromaIndexer = require(p);
        } catch {
          // noop – will attempt dynamic import next
        }
      }

      /*
       * ESM path
       * --------
       * If `require()` failed (or is unavailable because the code was bundled
       * as an ES module) fall back to a native dynamic import with the
       * `file://` prefix.
       */
      if (!chromaIndexer) {
        // Use a runtime-evaluated dynamic import to avoid ts-node rewriting it
        // into a CJS require() (which cannot handle file URLs or ESM modules).
        try {
          // Node supports importing either a file URL or absolute path.
          const url = p.startsWith('/') ? `file://${p}` : p;
          // eslint-disable-next-line no-new-func
          chromaIndexer = await (new Function('u', 'return import(u)'))(url);
        } catch {
          chromaIndexer = undefined;
        }
      }

      if (chromaIndexer) {
        InMemoryChromaClient = chromaIndexer.InMemoryChromaClient;
        indexStickiesFn = chromaIndexer.indexStickies;
        console.log('[WORKER] Successfully loaded chroma-indexer from', p);
        return;
      }
    } catch (err) {
      console.warn('[WORKER] Could not load chroma-indexer from', p, ':', (err as Error).message);
    }
  }

  // If we reached here, loading failed – fall back to stub
  InMemoryChromaClient = class {
    async getOrCreateCollection() {
      return {
        async query() {
          return { ids: [[]], metadatas: [[]], distances: [[]] };
        },
      };
    }
  };
  indexStickiesFn = undefined;
  console.log('[WORKER] Using fallback InMemoryChromaClient stub');
}

// Load environment variables from .env.local and .env files
dotenv.config({ path: path.resolve(__dirname, '../../../.env.local') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

console.log('[WORKER] Environment check:');
console.log('  - OPENAI_API_KEY present:', !!process.env.OPENAI_API_KEY);
console.log('  - CHROMA_URL:', process.env.CHROMA_URL || 'not set');

export interface Snippet {
  id: string;
  stickyTitle: string;
  content: string;
  similarity: number;
  filePath?: string;
}

export interface PipelineResult {
  snippets: Snippet[];
  summary: string;
}

interface PipelineOptions {
  openai?: OpenAI;
  chromaClient?: any;
  similarityThreshold?: number;
}

interface PipelineState {
  paragraphText: string;
  embedding?: number[];
  retrievedIds?: string[];
  retrievedMetas?: any[];
  retrievedEmbeddings?: number[][];
  similarities?: number[];
  filteredSnippets?: Snippet[];
  summary?: string;
}

async function getChromaClient(opts: PipelineOptions): Promise<any> {
  if (opts.chromaClient) return opts.chromaClient;
  
  // Try to use real ChromaDB if available
  if (ChromaClientCtor) {
    try {
      const client = new ChromaClientCtor({ path: process.env.CHROMA_URL });
      // Test connection
      await client.getOrCreateCollection({ name: 'connection_test' });
      await client.deleteCollection({ name: 'connection_test' });
      console.log('[WORKER] Using ChromaDB server');
      return client;
    } catch (error) {
      console.warn('[WORKER] ChromaDB server not available, falling back to in-memory client:', error.message);
    }
  }
  
  // Fallback to in-memory client
  console.log('[WORKER] Using in-memory ChromaDB client');
  return new InMemoryChromaClient();
}

function getOpenAI(opts: PipelineOptions): OpenAI | undefined {
  return opts.openai || (process.env.OPENAI_API_KEY ? new OpenAI() : undefined);
}

/**
 * Generate embedding for text using OpenAI or fallback
 */
async function generateEmbedding(text: string, openai: OpenAI): Promise<number[]> {
  if (process.env.OPENAI_API_KEY && process.env.NODE_ENV !== 'test') {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      console.warn('🔄 [WORKER] OpenAI embedding failed, using fallback:', error);
    }
  }
  
  // Fallback: deterministic hash-based embedding
  console.log('🔄 [WORKER] Using fallback embedding generation');
  const result = new Array(1536).fill(0); // Match OpenAI embedding dimensions
  for (let i = 0; i < text.length; i++) {
    result[i % 1536] += text.charCodeAt(i);
  }
  return result.map(v => (v % 1000) / 1000); // Normalize
}

/**
 * Generate summary using OpenAI or fallback
 */
async function generateSummary(paragraph: string, snippets: Snippet[], openai: OpenAI): Promise<string> {
  if (process.env.OPENAI_API_KEY && process.env.NODE_ENV !== 'test') {
    try {
      const contextText = snippets.map(s => `- ${s.stickyTitle}: ${s.content}`).join('\n');
      const prompt = ` You are an assistant in a Mac desktop application. The user is typing in a sticky note. Relevant snippets from their old Sticky notes are being retrieved via RAG and shown to them. You will be summarizing the snippets, starting with the information most valuable to the specific subproblem they are currently solving or the specific subtopic they are currently reflecting on. For example, if the user is trying to brainstorm app ideas, the MOST VALUABLE INFORMATION is SPECIFIC APP IDEAS that they wrote in the retrieved snippets. 
      
      In your summary, do not mention any quotes that might contain sensitive information or curse words or embarrassing personal information because this technology will be shown in a tech demo.
      
      Once again -- if the user is brainstorming app ideas, the most valuable information that your response must start with is SPECIFIC app ideas that they have written. Another example: If the user is writing 'What kind of song should I make?' then you should be specifically reminding them of old songs ideas they wanted to make in the past. Not sharing unrelated tips and tricks. Specifically address EXACTLY what they're thinking about. Extract ONLY the most useful information from the retrieved snippets. Put the MOST VALUABLE INFORMATION at the top of your response. Please bold the most valuable parts of your response. For example, if the user is trying to come up with app ideas, then the name of the apps that they have ideas for should be bolded. This is what the user is currently typing and thinking about:\n\n"${paragraph}"\n\nThese are the relevant snippets retrieved from their old Sticky notes related to what they are currently typing and thinking about: \n${contextText}\n\nNow summarize the content of the retrieved Stickies in a way that concisely gives them the valuable related information that might help them solve their current problems or assist them in their thought process. Your summary should include specific quotes from the retrieved snippets and should include specific details. Avoid fluff language. If you have nothing useful to say, then be honest that the retrieved snippets might not be relevant. In your response, do not begin with a preface. Go straight into providing the user helpful information related to whatever they're thinking about, formatted with a short title (2-5 words) that summarizes how you interpreted what the user might be looking for, and explicitly references the fact that you are summarizing information from their Sticky notes. Your response should be in plain text, do not use markdown. Instead of bullet points, use single dashes "-". Do not add a conclusion line at the end of your response. Do not add fluff on each summary item, just give the related quote `;
      console.log('\n\n\n\n\n>> sending OpenAI summarization prompt:', prompt);
      const response = await openai.chat.completions.create({
        model: 'gpt-4.1-2025-04-14',
        max_tokens: 512,
        messages: [
          { role: 'system', content: 'You are a concise assistant that summarizes text.' },
          { role: 'user', content: prompt },
        ],
      });
      
      return response.choices[0].message.content || 'Summary generation failed.';
    } catch (error) {
      console.warn('🔄 [WORKER] OpenAI summarization failed, using fallback:', error);
    }
  }
  
  // Fallback summary
  console.log('🔄 [WORKER] Using fallback summary generation');
  return `Summary of paragraph (${paragraph.length} chars) with ${snippets.length} related snippets found.`;
}

/** Main RAG pipeline */
export async function runRagPipeline(paragraph: string, options?: {
  openai?: OpenAI;
  chromaClient?: any;
  similarityThreshold?: number;
}): Promise<PipelineResult> {
  console.log('🚀 [WORKER] Starting RAG pipeline');
  console.log('📝 [WORKER] Input paragraph:', paragraph.substring(0, 100) + '...');
  console.log('📏 [WORKER] Input length:', paragraph.length, 'characters');

  // Ensure chroma-indexer is loaded
  if (!InMemoryChromaClient) {
    await loadChromaIndexer();
  }

  const openai = options?.openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const chromaClient = options?.chromaClient || (await getChromaClient({}));
  const similarityThreshold = options?.similarityThreshold ?? 0.3;
  const collectionName = process.env.CHROMA_COLLECTION_NAME || 'stickies_rag_v1';

  console.log('🔧 [WORKER] Configuration:');
  console.log('  - OpenAI available:', !!openai);
  console.log('  - ChromaDB client type:', chromaClient.constructor.name);
  console.log('  - Similarity threshold:', similarityThreshold);

  // Step 1: Generate embedding
  console.log('🧠 [WORKER] Step 1: Generating embedding...');
  const embedding = await generateEmbedding(paragraph, openai);
  console.log('✅ [WORKER] Embedding generated, dimensions:', embedding.length);

  // Step 2: Retrieve similar content
  console.log('🔍 [WORKER] Step 2: Querying ChromaDB for similar content...');
  let collection = await chromaClient.getOrCreateCollection({ name: collectionName });

  // Debug: print collection stats and first few items
  if (typeof collection.count === 'function') {
    try {
      const total = await collection.count();
      console.log(`[WORKER] Collection contains ${total} vectors`);
    } catch (err) {
      console.warn('[WORKER] Could not count collection size:', (err as Error).message);
    }
  }

  if (typeof collection.get === 'function') {
    try {
      // Many client versions accept { limit, include }
      const previewRes: any = await collection.get({ limit: 5, include: ['metadatas', 'ids'] });
      const idsPreview = previewRes.ids?.[0] || previewRes.ids || [];
      const metaPreview = previewRes.metadatas?.[0] || previewRes.metadatas || [];
      console.log('[WORKER] Preview of first 5 vectors:');
      idsPreview.slice(0, 5).forEach((id: string, idx: number) => {
        const meta = metaPreview[idx] || {};
        console.log(`  ${idx + 1}. id=${id}, stickyTitle=${meta.stickyTitle || 'N/A'}, textPreview="${(meta.text || '').substring(0, 80)}"`);
      });
    } catch (err) {
      console.warn('[WORKER] Could not fetch preview vectors:', (err as Error).message);
    }
  }

  const k = 5;
  console.log('📊 [WORKER] Querying for top', k, 'similar results');
  let queryResult: any;
  try {
    queryResult = await collection.query({ queryEmbeddings: [embedding], nResults: k });
  } catch (error: any) {
    const msg = (error as Error).message || '';
    if (msg.includes('dimension')) {
      console.warn('⚠️  [WORKER] Detected embedding dimension mismatch. Re-indexing collection.');
      if (typeof chromaClient.deleteCollection === 'function') {
        await chromaClient.deleteCollection({ name: collectionName });
      }
      // Ensure chroma-indexer is available
      if (!indexStickiesFn) {
        await loadChromaIndexer();
      }
      if (indexStickiesFn) {
        console.log('🔄 [WORKER] Running indexStickies to rebuild collection...');
        const defaultStickiesDir =
          process.env.STICKIES_DIR ||
          path.join(homedir(), 'Library/Containers/com.apple.Stickies/Data/Library/Stickies');
        await indexStickiesFn({ client: chromaClient, stickiesDir: defaultStickiesDir });
        console.log('✅ [WORKER] Re-index completed');
        collection = await chromaClient.getOrCreateCollection({ name: collectionName });
        queryResult = await collection.query({ queryEmbeddings: [embedding], nResults: k });
      } else {
        throw new Error('Failed to load indexStickies for re-indexing');
      }
    } else {
      throw error;
    }
  }

  const ids = queryResult.ids[0] as string[];
  const metas = queryResult.metadatas[0] as any[];
  const distances = queryResult.distances?.[0] as number[];

  console.log('📋 [WORKER] Retrieved', ids.length, 'potential matches');
  if (distances) {
    console.log('📐 [WORKER] Distance range:', Math.min(...distances).toFixed(3), 'to', Math.max(...distances).toFixed(3));
  }

  // Debug: log each retrieved snippet preview before filtering
  ids.forEach((id, idx) => {
    const meta = metas[idx] || {};
    const dist = distances ? distances[idx] : 'N/A';
    const preview = (meta.text || '').substring(0, 120).replace(/\n/g, ' ');
    console.log(`🔎 [WORKER] Raw result ${idx + 1}: id=${id}, dist=${typeof dist === 'number' ? dist.toFixed(3) : dist}, stickyTitle=${meta.stickyTitle || 'N/A'}, preview="${preview}"`);
  });

  // Step 3: Filter by similarity
  console.log('🔬 [WORKER] Step 3: Filtering by similarity threshold...');
  const filteredSnippets: Snippet[] = [];
  for (let i = 0; i < ids.length; i++) {
    const similarity = distances ? 1 / (1 + distances[i]) : 0.5; // Convert distance to similarity (0-1)
    console.log(`📌 [WORKER] Result ${i + 1}: similarity=${similarity.toFixed(3)}, threshold=${similarityThreshold}`);
    
    if (similarity >= similarityThreshold) {
      console.log(`✅ [WORKER] Including result ${i + 1} (similarity: ${similarity.toFixed(3)})`);
      filteredSnippets.push({
        id: ids[i],
        stickyTitle: metas[i]?.stickyTitle || 'Unknown',
        content: metas[i]?.text || 'No content',
        similarity: parseFloat(similarity.toFixed(3)),
        filePath: metas[i]?.filePath,
      });
    } else {
      console.log(`❌ [WORKER] Excluding result ${i + 1} (similarity: ${similarity.toFixed(3)} < ${similarityThreshold})`);
    }
  }

  console.log('📊 [WORKER] Filtered results:', filteredSnippets.length, 'of', ids.length, 'passed threshold');

  // Step 4: Generate summary
  console.log('📝 [WORKER] Step 4: Generating AI summary...');
  const summary = await generateSummary(paragraph, filteredSnippets, openai);
  console.log('✅ [WORKER] Summary generated, length:', summary.length, 'characters');
  console.log('📄 [WORKER] Summary preview:', summary.substring(0, 100) + '...');

  console.log('🎉 [WORKER] RAG pipeline completed successfully!');
  console.log('📊 [WORKER] Final results:');
  console.log('  - Snippets:', filteredSnippets.length);
  console.log('  - Summary length:', summary.length);

  return {
    snippets: filteredSnippets,
    summary,
  };
}

// Worker process mode
if (process.argv.includes('--child')) {
  console.log('🔧 [WORKER] Starting in child process mode');
  console.log('🆔 [WORKER] Process PID:', process.pid);

  process.on('message', async (msg: any) => {
    if (msg?.type === 'run') {
      console.log('📨 [WORKER] Received run message');
      try {
        const result = await runRagPipeline(msg.paragraph);
        process.send?.({ type: 'result', result });
      } catch (error) {
        console.error('❌ [WORKER] Error processing paragraph:', error);
        process.send?.({ type: 'error', error: (error as Error).message });
      }
    }
  });

  console.log('👂 [WORKER] Listening for messages from main process...');
}