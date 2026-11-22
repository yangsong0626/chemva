#!/usr/bin/env node
/**
 * Chemva — static target-page generator.
 *
 * Reads tools/targets.json (gene symbols), resolves each against ChEMBL,
 * pulls its quantitative activity data, and writes a real HTML page per
 * target under t/ plus targets.html, sitemap.xml and robots.txt.
 *
 * The pages are static so search engines can read them; each one deep-links
 * into the app (index.html#doc-CHEMBLxxxx) to open that series live.
 *
 *   node tools/build-pages.mjs            # all targets in targets.json
 *   node tools/build-pages.mjs JAK1 BTK   # just these
 *
 * Env:
 *   CHEMBL_BASE  override the API root (used by the test mock)
 *   SITE_BASE    canonical site root, default https://yangsong0626.github.io/chemva
 *   MAX_ACTS     cap on activity records per target, default 8000
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import initRDKit from '../vendor/RDKit_minimal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const API = (process.env.CHEMBL_BASE || 'https://www.ebi.ac.uk/chembl/api/data').replace(/\/$/, '');
const SITE = (process.env.SITE_BASE || 'https://yangsong0626.github.io/chemva').replace(/\/$/, '');
const MAX_ACTS = +(process.env.MAX_ACTS || 8000);
const BUILT = new Date().toISOString().slice(0, 10);

let RD;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(pathOrUrl, params){
  const url = pathOrUrl.startsWith('http') ? pathOrUrl
    : pathOrUrl.startsWith('/chembl/') ? API.replace(/\/chembl\/api\/data$/, '') + pathOrUrl
    : `${API}/${pathOrUrl}?` + new URLSearchParams({ format: 'json', ...params });
  for (let attempt = 0; attempt < 4; attempt++){
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      if (r.status === 429 || r.status >= 500){ await sleep(2000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.json();
    } catch (e){
      if (attempt === 3) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => v >= 1000 ? String(Math.round(v)) : v >= 100 ? v.toFixed(0) : v >= 10 ? (+v.toPrecision(3)).toString() : (+v.toPrecision(2)).toString();

/* ---------- resolve a gene symbol to one human single-protein target ---------- */
async function resolveTarget(gene){
  const tryList = [];
  try {
    const exact = await api('target.json', {
      target_type: 'SINGLE PROTEIN', organism: 'Homo sapiens', limit: 20,
      target_components__target_component_synonyms__component_synonym__iexact: gene,
      only: 'target_chembl_id,pref_name,organism,target_type'
    });
    tryList.push(...(exact.targets || []));
  } catch (e){ /* fall through to search */ }
  if (!tryList.length){
    try {
      const s = await api('target/search.json', { q: gene, limit: 25, only: 'target_chembl_id,pref_name,organism,target_type' });
      tryList.push(...(s.targets || []).filter(t => t.target_type === 'SINGLE PROTEIN' && t.organism === 'Homo sapiens'));
    } catch (e){ /* give up below */ }
  }
  if (!tryList.length) return null;
  // confirm the gene symbol really is one of the component synonyms
  for (const t of tryList.slice(0, 5)){
    try {
      const full = await api(`target/${t.target_chembl_id}.json`, {});
      const syns = (full.target_components || []).flatMap(c =>
        [...(c.target_component_synonyms || []).map(s => s.component_synonym), c.accession]);
      if (syns.some(s => String(s).toUpperCase() === gene.toUpperCase()))
        return { id: t.target_chembl_id, pref: full.pref_name || t.pref_name, organism: full.organism || t.organism,
                 accession: (full.target_components || [])[0]?.accession || null };
    } catch (e){ /* try the next candidate */ }
  }
  const t = tryList[0];
  return { id: t.target_chembl_id, pref: t.pref_name, organism: t.organism, accession: null };
}

/* ---------- activities for a target, grouped into series by document ---------- */
async function targetData(t){
  const only = 'molecule_chembl_id,document_chembl_id,document_year,document_journal,standard_type,pchembl_value';
  const q = { target_chembl_id: t.id, pchembl_value__isnull: 'false', limit: 1000, only };
  const first = await api('activity.json', q);
  const total = first.page_meta?.total_count ?? (first.activities || []).length;
  const acts = [...(first.activities || [])];
  const want = Math.min(total, MAX_ACTS);
  for (let off = 1000; off < want; off += 1000){
    const js = await api('activity.json', { ...q, offset: off });
    acts.push(...(js.activities || []));
    await sleep(120);
  }
  if (!acts.length) return null;

  const docs = new Map();
  const best = new Map();                                  // molecule -> max pChEMBL
  const types = {};
  acts.forEach(a => {
    const p = parseFloat(a.pchembl_value);
    if (!isNaN(p)) best.set(a.molecule_chembl_id, Math.max(best.get(a.molecule_chembl_id) ?? -99, p));
    types[a.standard_type] = (types[a.standard_type] || 0) + 1;
    if (!a.document_chembl_id) return;
    let d = docs.get(a.document_chembl_id);
    if (!d){ d = { id: a.document_chembl_id, year: a.document_year, journal: a.document_journal, mols: new Set(), p: [], types: {} }; docs.set(d.id, d); }
    d.mols.add(a.molecule_chembl_id);
    if (!isNaN(p)) d.p.push(p);
    d.types[a.standard_type] = (d.types[a.standard_type] || 0) + 1;
  });

  const series = [...docs.values()].filter(d => d.mols.size >= 5 && d.p.length)
    .sort((a, b) => b.mols.size - a.mols.size).slice(0, 25);

  // titles for the series we show
  for (let k = 0; k < series.length; k += 20){
    const ids = series.slice(k, k + 20).map(d => d.id).join(',');
    try {
      const js = await api('document.json', { document_chembl_id__in: ids, limit: 20,
        only: 'document_chembl_id,title,authors,journal,year,volume,first_page,doi,doc_type' });
      (js.documents || []).forEach(x => {
        const d = docs.get(x.document_chembl_id);
        if (d) Object.assign(d, { title: x.title, authors: x.authors, journal: x.journal || d.journal,
          year: x.year || d.year, volume: x.volume, first_page: x.first_page, doi: x.doi, doc_type: x.doc_type });
      });
    } catch (e){ /* titles are optional */ }
    await sleep(120);
  }

  // structures for the most potent compounds
  const top = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const smiles = new Map();
  if (top.length){
    try {
      const js = await api('molecule.json', { molecule_chembl_id__in: top.map(x => x[0]).join(','), limit: 20,
        only: 'molecule_chembl_id,molecule_structures,pref_name' });
      (js.molecules || []).forEach(m => {
        const s = m.molecule_structures?.canonical_smiles;
        if (s) smiles.set(m.molecule_chembl_id, { smi: s, name: m.pref_name || null });
      });
    } catch (e){ /* structures are optional */ }
  }

  const ps = [...best.values()];
  return {
    nActs: acts.length, total, capped: total > acts.length,
    nMols: best.size, nDocs: docs.size, series,
    pMin: Math.min(...ps), pMax: Math.max(...ps),
    types: Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6),
    top: top.map(([id, p]) => ({ id, p, ...(smiles.get(id) || {}) })).filter(x => x.smi)
  };
}

/* ---------- rendering ---------- */
function structSvg(smi, w = 200, h = 150){
  let m;
  try {
    m = RD.get_mol(smi);
    if (!m) return '';
    try { m.set_new_coords(true); m.straighten_depiction(); } catch (e){}
    return m.get_svg_with_highlights(JSON.stringify({
      width: w, height: h, bondLineWidth: 1.4, fixedBondLength: 17, padding: 0.06,
      clearBackground: false, addStereoAnnotation: true, minFontSize: 10, maxFontSize: 16
    })).replace(/<\?xml[^>]*\?>/, '');
  } catch (e){ return ''; } finally { try { m && m.delete(); } catch (e){} }
}
const nMtxt = p => { const nM = Math.pow(10, 9 - p); return nM < 1 ? nM.toFixed(2) : num(nM); };

function shell({ title, desc, canonical, body, jsonld, crumb }){
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
<style>
:root{--bg:#f6f7f9;--panel:#fff;--ink:#1d2430;--muted:#6b7380;--line:#e3e6eb;--accent:#2563a8;--accent-soft:#e8f0fa}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif}
header{background:#fff;border-bottom:1px solid var(--line);padding:13px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.logo{font-weight:700;font-size:19px;letter-spacing:-.2px;color:var(--ink);text-decoration:none}
.logo span{color:var(--accent)}
header nav{margin-left:auto;display:flex;gap:16px;font-size:14px}
header nav a{color:var(--muted);text-decoration:none}
header nav a:hover{color:var(--accent)}
main{max-width:980px;margin:0 auto;padding:22px}
.crumb{font-size:13px;color:var(--muted);margin-bottom:10px}
.crumb a{color:var(--muted)}
h1{font-size:25px;line-height:1.35;margin:.2em 0 .35em}
h2{font-size:17px;margin:34px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
.lede{font-size:15.5px;color:#39404c}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
.stat{flex:1 1 130px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:9px 13px}
.stat b{display:block;font-size:20px}
.stat span{font-size:12px;color:var(--muted)}
.cta{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:9px;padding:9px 17px;font-weight:600;margin:4px 8px 4px 0}
.cta.alt{background:#fff;color:var(--accent);border:1px solid #bcd3ea}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.mol{background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px;text-align:center}
.mol svg{max-width:100%;height:auto}
.mol a{font-size:12.5px;color:var(--accent);text-decoration:none;word-break:break-all}
.mol em{display:block;font-style:normal;font-size:13px;font-weight:600;margin-top:3px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:9px 11px;border-bottom:1px solid #eef0f3;text-align:left;vertical-align:top}
th{background:#f3f5f8;font-size:12.5px;color:#49505c;white-space:nowrap}
td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
td a{color:var(--accent);text-decoration:none}
td a:hover{text-decoration:underline}
.sub{display:block;color:var(--muted);font-size:12.5px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}
.tag{background:var(--accent-soft);color:#24507e;border-radius:99px;padding:2px 10px;font-size:12.5px}
.note{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 15px;font-size:13px;color:var(--muted);margin-top:28px}
.alpha{display:flex;flex-wrap:wrap;gap:7px}
.alpha a{background:#fff;border:1px solid var(--line);border-radius:8px;padding:6px 11px;text-decoration:none;color:var(--ink);font-size:14px}
.alpha a:hover{border-color:var(--accent);color:var(--accent)}
.alpha a span{color:var(--muted);font-size:12px;margin-left:4px}
footer{max-width:980px;margin:0 auto;padding:16px 22px 36px;color:var(--muted);font-size:12.5px}
footer a{color:var(--muted)}
</style>
</head>
<body>
<header>
  <a class="logo" href="${SITE}/">Chem<span>va</span></a>
  <nav><a href="${SITE}/targets.html">靶点索引</a><a href="${SITE}/">打开工具</a><a href="https://github.com/yangsong0626/chemva">GitHub</a></nav>
</header>
<main>
${crumb ? `<div class="crumb">${crumb}</div>` : ''}
${body}
</main>
<footer>
  数据来自 <a href="https://www.ebi.ac.uk/chembl/">ChEMBL</a>，遵循 CC BY-SA 3.0。页面由 <a href="https://github.com/yangsong0626/chemva">Chemva</a> 自动生成，更新于 ${BUILT}。
  结构图由 RDKit 渲染。本页仅汇总公开数据，不构成任何研发建议。
</footer>
</body>
</html>`;
}

function targetPage(t, g, d){
  const gene = g.gene, zh = g.zh || gene;
  const url = `${SITE}/t/${gene}.html`;
  const strongest = d.top[0];
  const title = `${gene}（${zh}）抑制剂 SAR 数据 — ${d.nMols} 个化合物、${d.series.length} 个系列 | Chemva`;
  const desc = `${gene} / ${t.pref} 的公开 SAR 数据汇总：ChEMBL 里 ${d.nMols} 个有定量活性的化合物，${d.nDocs} 篇文献与专利，`
    + `活性范围 pChEMBL ${d.pMin.toFixed(1)}–${d.pMax.toFixed(1)}（约 ${nMtxt(d.pMax)}–${nMtxt(d.pMin)} nM）。可一键在浏览器里生成 SAR 表、R 基团分解和活性–性质图。`;

  const stats = [
    [d.nMols.toLocaleString(), '个化合物'],
    [d.nDocs.toLocaleString(), '篇文献 / 专利'],
    [d.series.length, '个 ≥5 化合物的系列'],
    [`${nMtxt(d.pMax)} nM`, '最强活性'],
    [`${d.pMin.toFixed(1)}–${d.pMax.toFixed(1)}`, 'pChEMBL 范围'],
  ];

  const seriesRows = d.series.map(s => {
    const pm = Math.max(...s.p), isPat = s.doc_type === 'PATENT' || !s.journal;
    const cite = [s.journal || (isPat ? '专利 / 其他' : ''), s.year, s.volume && s.first_page ? `${s.volume}, ${s.first_page}` : ''].filter(Boolean).join(' · ');
    const main = Object.entries(s.types).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    return `<tr>
  <td><a href="${SITE}/index.html#doc-${esc(s.id)}">${esc(s.title || s.id)}</a>
      <span class="sub">${esc(cite)}${s.authors ? ' · ' + esc(s.authors.split(',')[0].trim()) + ' et al.' : ''}</span></td>
  <td class="n">${s.mols.size}</td>
  <td class="n">${esc(main)}</td>
  <td class="n">${nMtxt(pm)} nM</td>
  <td class="n"><a href="https://www.ebi.ac.uk/chembl/explore/document/${esc(s.id)}">ChEMBL</a>${s.doi ? ` · <a href="https://doi.org/${esc(s.doi)}">原文</a>` : ''}</td>
</tr>`;
  }).join('\n');

  const mols = d.top.slice(0, 8).map(m => `<div class="mol">
  ${structSvg(m.smi)}
  <em>${nMtxt(m.p)} nM</em>
  <a href="https://www.ebi.ac.uk/chembl/explore/compound/${esc(m.id)}">${esc(m.name || m.id)}</a>
</div>`).join('\n');

  const body = `
<h1>${esc(gene)}（${esc(zh)}）抑制剂 SAR 数据</h1>
<p class="lede">${esc(t.pref)}${t.organism ? `（${esc(t.organism)}）` : ''}，ChEMBL ID
  <a href="https://www.ebi.ac.uk/chembl/explore/target/${esc(t.id)}">${esc(t.id)}</a>${t.accession ? ` · UniProt <a href="https://www.uniprot.org/uniprotkb/${esc(t.accession)}">${esc(t.accession)}</a>` : ''}。
  这里汇总了 ChEMBL 里 ${esc(gene)} 的全部定量活性数据，按文献分组 —— 一篇文献基本就是一个药化系列。
  点任意一个系列，就能在浏览器里直接得到它的 SAR 表、R 基团分解、活性–性质散点图和自动解读，数据全程不离开你的电脑。</p>
<div class="stats">${stats.map(([v, k]) => `<div class="stat"><b>${esc(String(v))}</b><span>${esc(k)}</span></div>`).join('')}</div>
<p><a class="cta" href="${SITE}/index.html#target-${esc(t.id)}">在 Chemva 里打开 ${esc(gene)}</a>
   <a class="cta alt" href="${SITE}/targets.html">看别的靶点</a></p>
<div class="tags">${d.types.map(([k, v]) => `<span class="tag">${esc(k)} ${v.toLocaleString()} 条</span>`).join('')}</div>

<h2>活性最强的化合物</h2>
<div class="grid">${mols}</div>

<h2>SAR 系列（按文献分组）</h2>
<table>
<thead><tr><th>文献 / 专利</th><th>化合物</th><th>主要活性类型</th><th>最强</th><th>链接</th></tr></thead>
<tbody>
${seriesRows}
</tbody>
</table>
<p class="lede" style="margin-top:14px;font-size:14px;color:var(--muted)">
  表里只列了化合物数最多的 ${d.series.length} 个系列${d.capped ? `；${esc(gene)} 的活性记录共 ${d.total.toLocaleString()} 条，本页统计用了前 ${d.nActs.toLocaleString()} 条` : ''}。
  在 Chemva 里打开后可以按年份、化合物数或活性排序，也能只看论文或只看专利。</p>

<div class="note">
  <b>这些数字是怎么来的：</b>取 ChEMBL 中 ${esc(t.id)} 上带 pChEMBL 值的活性记录（也就是单位统一、关系为 “=” 的定量数据），
  按化合物去重时取其最强的一条，按文献分组后只保留 ≥5 个化合物的系列。pChEMBL 换算成 nM 的公式是 10^(9−pChEMBL)。
  同一化合物在不同实验条件下的数值可能相差很大，直接横向比较之前请回到原文确认实验方法。
</div>`;

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'Dataset',
    name: `${gene} SAR 数据汇总`, description: desc, url,
    keywords: [gene, t.pref, 'SAR', 'ChEMBL', '构效关系', '抑制剂', '药物化学'],
    license: 'https://creativecommons.org/licenses/by-sa/3.0/',
    isBasedOn: `https://www.ebi.ac.uk/chembl/explore/target/${t.id}`,
    creator: { '@type': 'Organization', name: 'Chemva' },
    dateModified: BUILT
  };
  const crumb = `<a href="${SITE}/">Chemva</a> › <a href="${SITE}/targets.html">靶点</a> › ${esc(gene)}`;
  return shell({ title, desc, canonical: url, body, jsonld, crumb });
}

function indexPage(built){
  const total = built.reduce((s, b) => s + b.d.nMols, 0);
  const title = `药物靶点 SAR 数据索引 — ${built.length} 个靶点、${total.toLocaleString()} 个化合物 | Chemva`;
  const desc = `按靶点浏览 ChEMBL 公开构效关系数据：${built.map(b => b.g.gene).slice(0, 12).join('、')} 等 ${built.length} 个常见药物靶点，`
    + `共 ${total.toLocaleString()} 个有定量活性的化合物。点进去可一键生成 SAR 表与活性–性质图。`;
  const rows = built.slice().sort((a, b) => a.g.gene.localeCompare(b.g.gene))
    .map(b => `<a href="${SITE}/t/${b.g.gene}.html">${esc(b.g.gene)}<span>${b.d.nMols.toLocaleString()}</span></a>`).join('\n');
  const table = built.slice().sort((a, b) => b.d.nMols - a.d.nMols).map(b => `<tr>
  <td><a href="${SITE}/t/${b.g.gene}.html">${esc(b.g.gene)}</a> <span class="sub">${esc(b.g.zh || '')} · ${esc(b.t.pref)}</span></td>
  <td class="n">${b.d.nMols.toLocaleString()}</td>
  <td class="n">${b.d.series.length}</td>
  <td class="n">${nMtxt(b.d.pMax)} nM</td>
</tr>`).join('\n');
  const body = `
<h1>药物靶点 SAR 数据索引</h1>
<p class="lede">这里按靶点整理了 ChEMBL 的公开构效关系数据，目前收录 ${built.length} 个常见药物靶点、
  ${total.toLocaleString()} 个有定量活性的化合物。每个靶点页按文献把化合物分成系列，点一下就能在浏览器里得到
  SAR 表、R 基团分解、活性–性质散点图和自动解读 —— 不用装软件，数据也不上传。</p>
<p><a class="cta" href="${SITE}/">打开 Chemva</a></p>
<h2>按字母</h2>
<div class="alpha">${rows}</div>
<h2>按化合物数</h2>
<table>
<thead><tr><th>靶点</th><th>化合物</th><th>系列</th><th>最强活性</th></tr></thead>
<tbody>${table}</tbody>
</table>`;
  const jsonld = {
    '@context': 'https://schema.org', '@type': 'CollectionPage', name: title, description: desc,
    url: `${SITE}/targets.html`, dateModified: BUILT,
    hasPart: built.map(b => ({ '@type': 'Dataset', name: `${b.g.gene} SAR 数据`, url: `${SITE}/t/${b.g.gene}.html` }))
  };
  return shell({ title, desc, canonical: `${SITE}/targets.html`, body, jsonld,
    crumb: `<a href="${SITE}/">Chemva</a> › 靶点` });
}

/* ---------- main ---------- */
async function main(){
  RD = await initRDKit();
  try { RD.prefer_coordgen(true); } catch (e){}
  const cfg = JSON.parse(await fs.readFile(path.join(HERE, 'targets.json'), 'utf8'));
  const want = process.argv.slice(2).map(s => s.toUpperCase());
  const list = want.length ? cfg.targets.filter(t => want.includes(t.gene.toUpperCase())) : cfg.targets;
  if (!list.length){ console.error('no targets matched'); process.exit(1); }

  await fs.mkdir(path.join(ROOT, 't'), { recursive: true });
  const built = [], skipped = [];
  for (const g of list){
    process.stdout.write(`${g.gene} … `);
    try {
      const t = await resolveTarget(g.gene);
      if (!t){ console.log('resolve failed, skipped'); skipped.push([g.gene, 'resolve']); continue; }
      const d = await targetData(t);
      if (!d || d.nMols < 30 || !d.series.length){
        console.log(`too little data (${d ? d.nMols : 0} mols), skipped`); skipped.push([g.gene, 'sparse']); continue;
      }
      await fs.writeFile(path.join(ROOT, 't', `${g.gene}.html`), targetPage(t, g, d));
      built.push({ g, t, d });
      console.log(`${t.id}  ${d.nMols} mols, ${d.series.length} series`);
    } catch (e){
      console.log('failed: ' + e.message); skipped.push([g.gene, e.message]);
    }
    await sleep(250);
  }
  if (!built.length){ console.error('nothing built'); process.exit(1); }

  await fs.writeFile(path.join(ROOT, 'targets.html'), indexPage(built));
  const urls = [`${SITE}/`, `${SITE}/targets.html`, ...built.map(b => `${SITE}/t/${b.g.gene}.html`)];
  await fs.writeFile(path.join(ROOT, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u => `  <url><loc>${u}</loc><lastmod>${BUILT}</lastmod></url>`).join('\n')
    + `\n</urlset>\n`);
  await fs.writeFile(path.join(ROOT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  console.log(`\nbuilt ${built.length} target pages, skipped ${skipped.length}`);
  if (skipped.length) console.log('skipped: ' + skipped.map(s => s.join('=')).join(', '));
}
main().catch(e => { console.error(e); process.exit(1); });
