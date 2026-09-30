// Index-side preprocessing and query routing (PLAN.md "分词与查询路由").
// fts_bigram (unicode61) holds two columns: `bi` = text with every CJK run cut into adjacent pairs,
// `uni` = CJK characters only, one token each. fts_tri (trigram) indexes raw `text` and `calls`.

const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uac00-\\ud7af\\uf900-\\ufaff\\u{20000}-\\u{2ffff}";
const CJK_RUN = new RegExp(`[${CJK_CLASS}]+`, "gu");
const CJK_ONLY = new RegExp(`^[${CJK_CLASS}]+$`, "u");
const WORD = /[\p{L}\p{N}]/u;

function pairs(run: string): string[] {
  const chars = [...run];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

export function bigramText(text: string): string {
  return text.replace(CJK_RUN, (run) => ` ${pairs(run).join(" ")} `);
}

export function unigramText(text: string): string {
  return (text.match(CJK_RUN) ?? []).map((run) => [...run].join(" ")).join(" ");
}

function quote(s: string): string {
  return `"${s.replaceAll('"', '""')}"`;
}

/** Query terms: whitespace-separated; a double-quoted span is one term. */
export function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim();
    if (t && WORD.test(t)) terms.push(t);
  }
  return terms;
}

export interface MatchPlan {
  /** All terms against fts_bigram: CJK single chars on `uni`, everything else as a `bi` phrase. */
  bigram: string;
  /** Terms of 3+ characters as trigram substrings; null when every term is shorter. */
  trigram: string | null;
  /** Terms under 3 characters, which trigram hits must also satisfy through fts_bigram. */
  shortOnly: string | null;
}

function bigramExpr(term: string): string {
  const chars = [...term];
  if (chars.length === 1 && CJK_ONLY.test(term)) return `uni : ${quote(term)}`;
  return `bi : ${quote(bigramText(term).trim())}`;
}

export function planMatch(terms: string[]): MatchPlan | null {
  if (terms.length === 0) return null;
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  return {
    bigram: terms.map(bigramExpr).join(" AND "),
    trigram: long.length ? long.map(quote).join(" AND ") : null,
    shortOnly: long.length && short.length ? short.map(bigramExpr).join(" AND ") : null,
  };
}
