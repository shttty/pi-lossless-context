// PROTOTYPE — throwaway. In-process CPU embedding comparison (transformers.js + onnxruntime-node), FTS baseline.
//   node bench.mjs probe <model>          # load time, throughput on 256 zh chunks, RSS, disk size
//   node bench.mjs run <model> zh|lme     # embed corpus (cached) + queries, report recall@k / MRR
//   node bench.mjs fts zh|lme             # SQLite FTS5 BM25 baseline (CJK bigram + unicode61 words, OR query)
// Ranking is per source message ("doc"): a doc scores its best chunk. LongMemEval searches only its own haystack.
import { Tokenizer } from "@huggingface/tokenizers";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, "cache");
const DATA = join(HERE, "data");

// Per-model usage from each model card: pooling and the query/document prefixes the model was trained with.
const QWEN_Q = "Instruct: Given a question, retrieve past conversation messages that answer it\nQuery:";
const MODELS = {
  "bge-small-zh": { id: "Xenova/bge-small-zh-v1.5", dtype: "q8", pooling: "cls", q: "为这个句子生成表示以用于检索相关文章：", d: "" },
  "e5-small": { id: "Xenova/multilingual-e5-small", dtype: "q8", pooling: "mean", q: "query: ", d: "passage: " },
  "minilm-l12": { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dtype: "q8", pooling: "mean", q: "", d: "" },
  "jina-zh": { id: "jinaai/jina-embeddings-v2-base-zh", dtype: "q8", pooling: "mean", q: "", d: "" },
  // q8 export of jina-zh degrades badly (30-way sanity MRR 0.49 vs fp16 0.81); fp16 variants for comparison.
  "jina-zh-fp16": { id: "jinaai/jina-embeddings-v2-base-zh", dtype: "fp16", pooling: "mean", q: "", d: "" },
  "minilm-l12-fp16": { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", dtype: "fp16", pooling: "mean", q: "", d: "" },
  "bge-small-zh-fp16": { id: "Xenova/bge-small-zh-v1.5", dtype: "fp16", pooling: "cls", q: "为这个句子生成表示以用于检索相关文章：", d: "" },
  "e5-small-fp16": { id: "Xenova/multilingual-e5-small", dtype: "fp16", pooling: "mean", q: "query: ", d: "passage: " },
  "gemma-300m": { id: "onnx-community/embeddinggemma-300m-ONNX", dtype: "q8", pooling: "mean", q: "task: search result | query: ", d: "title: none | text: " },
  "arctic-m-v2": { id: "Snowflake/snowflake-arctic-embed-m-v2.0", dtype: "q8", pooling: "cls", q: "query: ", d: "" },
  "bge-m3": { id: "Xenova/bge-m3", dtype: "q8", pooling: "cls", q: "", d: "" },
  "qwen3-0.6b": { id: "onnx-community/Qwen3-Embedding-0.6B-ONNX", dtype: "q8", pooling: "last_token", q: QWEN_Q, d: "" },
  // Model2Vec static model (distilled from BGE-M3): mean of token vectors, no transformer. Files in cache/potion.
  "potion": { id: "potion", static: true, q: "", d: "" },
  "potion-f16": { id: "potion", static: true, store: "f16", q: "", d: "" },
  "potion-i8": { id: "potion", static: true, store: "i8", q: "", d: "" },
};

const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
function dirSize(p) {
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const f of readdirSync(p)) { const q = join(p, f); const s = statSync(q); n += s.isDirectory() ? dirSize(q) : s.size; }
  return n;
}

// Model2Vec: tokenize (no special tokens, unk dropped, first 512 tokens), mean of rows, L2-normalize.
// Table storage per variant: f32 = view over the file buffer (no copy); f16 = Float16Array copy; i8 = per-row scale.
async function loadStatic(name) {
  const m = MODELS[name];
  const dir = join(CACHE, "potion");
  const t = performance.now();
  const tok = new Tokenizer(JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")), {});
  let buf = readFileSync(join(dir, "model.safetensors"));
  const hlen = Number(buf.readBigUInt64LE(0));
  const meta = JSON.parse(buf.subarray(8, 8 + hlen).toString("utf8")).embeddings;
  const [rows, dim] = meta.shape;
  const f32 = new Float32Array(buf.buffer, buf.byteOffset + 8 + hlen + meta.data_offsets[0], rows * dim);
  let row;  // (id, out accumulator) => void
  if (m.store === "f16") {
    const h = Float16Array.from(f32);
    row = (id, v) => { const o = id * dim; for (let j = 0; j < dim; j++) v[j] += h[o + j]; };
  } else if (m.store === "i8") {
    const q = new Int8Array(rows * dim), sc = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let mx = 0;
      for (let j = 0; j < dim; j++) mx = Math.max(mx, Math.abs(f32[r * dim + j]));
      sc[r] = mx / 127 || 1;
      for (let j = 0; j < dim; j++) q[r * dim + j] = Math.round(f32[r * dim + j] / sc[r]);
    }
    row = (id, v) => { const o = id * dim, s = sc[id]; for (let j = 0; j < dim; j++) v[j] += q[o + j] * s; };
  } else {
    row = (id, v) => { const o = id * dim; for (let j = 0; j < dim; j++) v[j] += f32[o + j]; };
  }
  if (m.store) buf = null;  // quantized copies no longer need the file buffer
  globalThis.gc?.();
  const unk = 1;
  const loadS = (performance.now() - t) / 1000;
  const steady = rss();
  let peak = steady;
  const embed = async (texts, prefix) => {
    const out = [];
    for (const x of texts) {
      const ids = tok.encode(prefix + x, { add_special_tokens: false }).ids.filter((id) => id !== unk).slice(0, 512);
      const v = new Float32Array(dim);
      for (const id of ids) row(id, v);
      let n = 0;
      for (let j = 0; j < dim; j++) n += v[j] * v[j];
      n = Math.sqrt(n) || 1;
      for (let j = 0; j < dim; j++) v[j] /= n;
      out.push(v);
    }
    peak = Math.max(peak, rss());
    return out;
  };
  return { m, embed, loadS, peak: () => peak, steady, diskMB: () => Math.round(dirSize(dir) / 1e6) };
}

async function load(name) {
  const m = MODELS[name];
  if (m.static) return loadStatic(name);
  const t = performance.now();
  // EMB_THREADS caps onnxruntime's intra-op threads (default: all cores); an in-agent model would not own the whole CPU.
  const threads = Number(process.env.EMB_THREADS) || undefined;
  // Transformer models only: imported lazily so the static (potion) path needs nothing but @huggingface/tokenizers.
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = CACHE;
  const ex = await pipeline("feature-extraction", m.id, {
    device: "cpu", dtype: m.dtype,
    ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {})
  });
  const loadS = (performance.now() - t) / 1000;
  let peak = rss();
  const embed = async (texts, prefix, batch = 16) => {
    const out = [];
    for (let i = 0; i < texts.length; i += batch) {
      const o = await ex(texts.slice(i, i + batch).map((x) => prefix + x),
        m.pooling === "last_token" ? { pooling: "last_token", normalize: true } : { pooling: m.pooling, normalize: true });
      out.push(...o.tolist().map((v) => Float32Array.from(v)));
      peak = Math.max(peak, rss());
    }
    return out;
  };
  return { m, embed, loadS, peak: () => peak, diskMB: () => Math.round(dirSize(join(CACHE, m.id)) / 1e6) };
}

function score(queries, rankOf) {
  const ks = [1, 5, 10, 20];
  const hit = Object.fromEntries(ks.map((k) => [k, 0]));
  let mrr = 0;
  const byType = {};
  for (const q of queries) {
    const ranked = rankOf(q);
    const gold = new Set(q.docs.map(String));
    const r = ranked.findIndex((d) => gold.has(String(d)));
    for (const k of ks) if (r >= 0 && r < k) hit[k] += 1;
    if (r >= 0) mrr += 1 / (r + 1);
    if (q.type) { byType[q.type] ??= [0, 0]; byType[q.type][0] += r >= 0 && r < 10 ? 1 : 0; byType[q.type][1] += 1; }
  }
  const n = queries.length;
  return {
    n, ...Object.fromEntries(ks.map((k) => [`R@${k}`, +(hit[k] / n).toFixed(3)])), MRR: +(mrr / n).toFixed(3),
    ...(Object.keys(byType).length ? { byType: Object.fromEntries(Object.entries(byType).map(([t, [a, b]]) => [t, `${a}/${b}`])) } : {})
  };
}

function rankDocs(scores, corpus, group) {
  const best = new Map();
  for (let i = 0; i < corpus.length; i++) {
    const c = corpus[i];
    if (group && c.group !== group) continue;
    const s = scores[i];
    if (!best.has(c.doc) || best.get(c.doc) < s) best.set(c.doc, s);
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([d]) => d);
}

const [mode, a, b] = process.argv.slice(2);

if (mode === "probe") {
  const L = await load(a);
  const texts = readJsonl(join(DATA, "zh-corpus.jsonl")).slice(2000, 2256).map((d) => d.text);
  const chars = texts.reduce((n, t) => n + t.length, 0);
  await L.embed(texts.slice(0, 16), L.m.d);
  const t = performance.now();
  await L.embed(texts, L.m.d);
  const s = (performance.now() - t) / 1000;
  const q0 = performance.now();
  for (let i = 0; i < 10; i++) await L.embed(["上次那个压缩方案最后定的是哪种？"], L.m.q, 1);
  const qms = (performance.now() - q0) / 10;
  const line = {
    model: a, loadS: +L.loadS.toFixed(1), chunksPerS: +(texts.length / s).toFixed(1), charsPerS: Math.round(chars / s),
    queryMs: Math.round(qms), steadyRssMB: L.steady ?? null, peakRssMB: L.peak(), diskMB: L.diskMB()
  };
  console.log(JSON.stringify(line));
  appendFileSync(join(HERE, "probe.jsonl"), JSON.stringify(line) + "\n");
} else if (mode === "run") {
  const L = await load(a);
  const corpus = readJsonl(join(DATA, `${b}-corpus.jsonl`));
  const queries = readJsonl(join(DATA, `${b}-queries.jsonl`));
  const cache = join(DATA, `emb-${a}-${b}.f32`);
  let vecs, embedS = null;
  if (existsSync(cache)) {
    const buf = readFileSync(cache);
    const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const dim = flat.length / corpus.length;
    vecs = Array.from({ length: corpus.length }, (_, i) => flat.subarray(i * dim, (i + 1) * dim));
  } else {
    const t = performance.now();
    vecs = await L.embed(corpus.map((d) => d.text), L.m.d);
    embedS = (performance.now() - t) / 1000;
    const flat = new Float32Array(vecs.length * vecs[0].length);
    vecs.forEach((v, i) => flat.set(v, i * v.length));
    writeFileSync(cache, Buffer.from(flat.buffer));
  }
  const qv = await L.embed(queries.map((q) => q.q), L.m.q);
  const rankOf = (q) => {
    const v = qv[queries.indexOf(q)];
    const s = new Float32Array(vecs.length);
    for (let i = 0; i < vecs.length; i++) { let d = 0; const x = vecs[i]; for (let j = 0; j < v.length; j++) d += x[j] * v[j]; s[i] = d; }
    return rankDocs(s, corpus, q.group);
  };
  const res = { model: a, set: b, ...score(queries, rankOf), loadS: +L.loadS.toFixed(1), embedMin: embedS && +(embedS / 60).toFixed(1), peakRssMB: L.peak() };
  writeFileSync(join(DATA, `rank-${a}-${b}.json`), JSON.stringify(queries.map((q) => rankOf(q))));
  console.log(JSON.stringify(res));
  appendFileSync(join(HERE, "results.jsonl"), JSON.stringify(res) + "\n");
} else if (mode === "fts") {
  const corpus = readJsonl(join(DATA, `${a}-corpus.jsonl`));
  const queries = readJsonl(join(DATA, `${a}-queries.jsonl`));
  const CJK_RUN = /[\p{Script=Han}]+/gu;
  const seg = (t) => t.replace(CJK_RUN, (run) => { const c = [...run]; return c.length === 1 ? ` ${run} ` : " " + c.slice(1).map((x, i) => c[i] + x).join(" ") + " "; });
  const db = new DatabaseSync(":memory:");
  db.exec("create virtual table f using fts5(t, g unindexed, tokenize='unicode61')");
  const ins = db.prepare("insert into f(rowid, t, g) values (?, ?, ?)");
  db.exec("begin");
  corpus.forEach((d, i) => ins.run(i, seg(d.text), d.group ?? ""));
  db.exec("commit");
  const STOP = new Set("a an the i my me you your is are was were do did does to of in on for and or what which who when how many much with at by from it that this have has had be".split(" "));
  const sel = db.prepare("select rowid, bm25(f) as s from f where f match ? and g = ? order by s limit 400");
  const selAll = db.prepare("select rowid, bm25(f) as s from f where f match ? order by s limit 400");
  const rankOf = (q) => {
    const terms = [...new Set(seg(q.q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w)))];
    if (!terms.length) return [];
    const expr = terms.map((w) => `"${w}"`).join(" OR ");
    const rows = q.group ? sel.all(expr, q.group) : selAll.all(expr);
    const s = new Float32Array(corpus.length).fill(-Infinity);
    for (const r of rows) s[r.rowid] = -r.s;
    return rankDocs(s, corpus, q.group).filter((d) => rows.some((r) => corpus[r.rowid].doc === d));
  };
  const res = { model: "fts-bm25", set: a, ...score(queries, rankOf) };
  writeFileSync(join(DATA, `rank-fts-bm25-${a}.json`), JSON.stringify(queries.map((q) => rankOf(q))));
  console.log(JSON.stringify(res));
  appendFileSync(join(HERE, "results.jsonl"), JSON.stringify(res) + "\n");
}
