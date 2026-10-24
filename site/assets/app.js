// LAIBench website. Every score on this page comes from the real scorer
// (./laibench-scorer.js, bundled from src/ by scripts/build-site-scorer.mjs).
import * as LB from "./laibench-scorer.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmt1 = (x) => (x == null || Number.isNaN(x) ? "—" : (Math.round(x * 10) / 10).toFixed(1));
const pct = (x) => (x == null ? "—" : `${fmt1(x * 100)}%`);
const DIM_ORDER = ["CRIT", "QUAL", "TERM", "GUIDE", "RAG"];

// ---------------------------------------------------------------- theme
(function theme() {
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem("laibench-theme"); } catch { /* storage unavailable */ }
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  $("#theme")?.addEventListener("click", () => {
    const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem("laibench-theme", next); } catch { /* ignore */ }
  });
  $("#yr").textContent = String(new Date().getFullYear());
})();

$$('[data-bind="version"]').forEach((el) => { el.textContent = LB.BENCHMARK_VERSION; });

// ---------------------------------------------------------------- report rendering + grease-pencil marks
const SECTION_RX = {
  technique: /^(?:technique|técnica|tecnica)$/i,
  findings: /^(?:findings|analysis|análise|analise|achados)$/i,
  impression: /^(?:impression|conclusion|conclusão|conclusao)$/i,
};
const decoder = document.createElement("textarea");
const decode = (s) => { decoder.innerHTML = s; return decoder.value; };

function parseReport(html) {
  const lines = [{ segs: [], center: false }];
  let bold = 0;
  let center = 0;
  const rx = /<(\/?)(center|b|br)\s*\/?>/gi;
  let last = 0;
  let m;
  const pushText = (t) => {
    if (!t) return;
    const line = lines[lines.length - 1];
    line.segs.push({ text: decode(t), bold: bold > 0 });
    if (center > 0) line.center = true;
  };
  while ((m = rx.exec(html)) !== null) {
    pushText(html.slice(last, m.index));
    last = m.index + m[0].length;
    const close = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (tag === "br") lines.push({ segs: [], center: false });
    else if (tag === "b") bold = Math.max(0, bold + (close ? -1 : 1));
    else if (tag === "center") center = Math.max(0, center + (close ? -1 : 1));
  }
  pushText(html.slice(last));
  return lines
    .map((l) => ({ ...l, text: l.segs.map((s) => s.text).join("").trim() }))
    .filter((l) => l.text.length > 0)
    .map((l) => {
      const allBold = l.segs.filter((s) => s.text.trim()).every((s) => s.bold);
      if (l.center) return { type: "title", text: l.text };
      if (allBold) {
        const name = Object.keys(SECTION_RX).find((k) => SECTION_RX[k].test(l.text.replace(/:$/, "")));
        if (name) return { type: "sec", name, text: l.text };
      }
      return { type: "text", text: l.text, segs: l.segs };
    });
}

const NEG_RX = /\b(?:no|without|negative for|absent|not (?:seen|identified|visualized|present)|sem|aus[êe]ncia de|n[ãa]o h[áa])\b/i;
const SIDE_WORD = { right: /\bright\b|\bdireit[ao]s?\b/i, left: /\bleft\b|\besquerd[ao]s?\b/i, bilateral: /\bbilateral(?:ly)?\b|\bbilaterais\b/i };

function splitName(name) {
  const m = /^(right|left|bilateral)\s+(.+)$/i.exec(name.trim());
  return m ? { side: m[1].toLowerCase(), term: m[2] } : { side: null, term: name.trim() };
}
const termRx = (term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "i");

function marksFromResult(result) {
  const marks = []; // {kind, sentence:(s)=>bool, word?:RegExp, title}
  const notes = []; // {section, text, sev}
  const oks = [];   // {sentence, title}
  for (const c of result.checks) {
    const ev = String(c.evidence ?? "");
    if (c.id === "C09") {
      for (const part of ev.split(" · ")) {
        const m = /^(preserved|omitted|negated in report|laterality swap|laterality missing): (.+?)(?: → (\w+))?$/.exec(part);
        if (!m) continue;
        const { side, term } = splitName(m[2]);
        const t = termRx(term);
        if (m[1] === "preserved") { oks.push({ sentence: (s) => t.test(s) && !NEG_RX.test(s), title: `C09: ${m[2]} preserved` }); continue; }
        if (m[1] === "omitted") notes.push({ section: "findings", sev: "critical", text: `<b>Omitted:</b> ${esc(m[2])} <span class="id">(C09)</span>` });
        if (m[1] === "negated in report") {
          marks.push({ kind: "deny", sentence: (s) => t.test(s) && NEG_RX.test(s), title: `C09: the input affirms ${m[2]}; the report denies it` });
          notes.push({ section: "findings", sev: "critical", text: `<b>Denied:</b> the input affirms ${esc(m[2])} <span class="id">(C09)</span>` });
        }
        if (m[1] === "laterality swap") {
          const to = (m[3] || "").toLowerCase();
          marks.push({ kind: "circle", sentence: (s) => t.test(s), word: SIDE_WORD[to] || SIDE_WORD.left, title: `C09: input says ${side}` });
          notes.push({ section: "findings", sev: "critical", text: `<b>Wrong side:</b> the input says ${esc(side)} ${esc(term)} <span class="id">(C09)</span>` });
        }
        if (m[1] === "laterality missing") {
          marks.push({ kind: "wave", sentence: (s) => t.test(s) && !NEG_RX.test(s), word: t, title: `C09: side missing, input says ${side}` });
          notes.push({ section: "findings", sev: "critical", text: `<b>Side missing:</b> the input says ${esc(side)} ${esc(term)} <span class="id">(C09)</span>` });
        }
      }
    } else if (c.id === "C10" && !c.passed) {
      for (const part of ev.split(" · ")) {
        const m = /(contralateral )?critical not in input: (.+)$/.exec(part);
        if (!m) continue;
        const { side, term } = splitName(m[2]);
        const t = termRx(term);
        const sw = side ? SIDE_WORD[side] : null;
        marks.push({ kind: "strike", sentence: (s) => t.test(s) && !NEG_RX.test(s) && (!sw || sw.test(s)), title: `C10: ${m[2]} is not in the input` });
        notes.push({ section: "findings", sev: "critical", text: `<b>Not in the input:</b> ${esc(m[2])} <span class="id">(C10)</span>` });
      }
    } else if (c.id === "R02" && !c.passed) {
      const swap = /SWAP: (\w+): input=(\w+), report=(\w+)/.exec(ev);
      if (swap) marks.push({ kind: "circle", sentence: (s) => new RegExp(swap[1], "i").test(s), word: SIDE_WORD[swap[3]] || SIDE_WORD.left, title: `R02: input says ${swap[2]}` });
      else notes.push({ section: "findings", sev: "critical", text: `<b>Side not stated:</b> ${esc(ev.replace(/^missing laterality: /, "the input says "))} <span class="id">(R02)</span>` });
    } else if (/^Q16-/.test(c.id)) {
      const m = /not reflected: "(.+)"$/.exec(ev);
      notes.push({ section: "findings", sev: "major", text: `<b>Not in the report:</b> “${esc(m ? m[1] : ev)}” <span class="id">(Q16)</span>` });
    } else if (c.id === "Q17" && !c.passed) {
      notes.push({ section: "impression", sev: "critical", text: `<b>None of the input's abnormal findings is in the report.</b> <span class="id">(Q17)</span>` });
    } else if (/^T\d\d$|^TO\d|^TM\d|^C01$/.test(c.id) && !c.passed && ev && ev !== "ok") {
      const words = ev.split(/,\s*/).filter(Boolean).slice(0, 4);
      for (const w of words) marks.push({ kind: "wave", sentence: (s) => termRx(w).test(s), word: termRx(w), title: `${c.id}: ${c.name}` });
    } else if (!c.passed && c.severity === "critical" && !["C09", "C10", "R02", "Q17"].includes(c.id)) {
      notes.push({ section: "top", sev: "critical", text: `<b>${esc(c.name)}</b> <span class="id">(${esc(c.id)}${ev && ev !== "ok" ? `: ${esc(ev)}` : ""})</span>` });
    }
  }
  // De-duplicate the markup (the check list below keeps every check): a Q16
  // omission or an R02 "missing laterality" that restates a C09 finding adds
  // noise, not information.
  const c09Terms = result.checks.filter((c) => c.id === "C09" && !c.passed)
    .flatMap((c) => String(c.evidence).split(" · ").map((p) => (/: (.+?)(?: → \w+)?$/.exec(p) || [])[1]).filter(Boolean))
    .map((n) => splitName(n).term.toLowerCase());
  const deduped = notes.filter((n) => {
    if (/\(Q16\)/.test(n.text)) return !c09Terms.some((t) => n.text.toLowerCase().includes(t));
    if (/\(R02\)/.test(n.text)) return c09Terms.length === 0;
    return true;
  });
  return { marks, notes: deduped, oks };
}

function renderSentence(s, marks, oks) {
  const sentenceMark = marks.find((m) => !m.word && m.sentence(s));
  let pieces = [{ t: s }];
  for (const m of marks.filter((x) => x.word && x.sentence(s))) {
    const next = [];
    for (const p of pieces) {
      if (p.cls) { next.push(p); continue; }
      const rx = new RegExp(m.word.source, m.word.flags.replace("g", ""));
      const hit = rx.exec(p.t);
      if (!hit) { next.push(p); continue; }
      next.push({ t: p.t.slice(0, hit.index) }, { t: hit[0], cls: `mk mk-${m.kind}`, title: m.title }, { t: p.t.slice(hit.index + hit[0].length) });
    }
    pieces = next;
  }
  let html = pieces.map((p) => (p.cls ? `<span class="${p.cls}" title="${esc(p.title)}">${esc(p.t)}</span>` : esc(p.t))).join("");
  if (sentenceMark) html = `<span class="mk mk-${sentenceMark.kind}" title="${esc(sentenceMark.title)}">${html}</span>`;
  const ok = oks.find((o) => o.sentence(s));
  if (ok) { html += `<span class="ok-mark" title="${esc(ok.title)}" aria-label="${esc(ok.title)}">✓</span>`; oks.splice(oks.indexOf(ok), 1); }
  return html;
}

function renderMarked(container, html, result) {
  const blocks = parseReport(html);
  const { marks, notes, oks } = result ? marksFromResult(result) : { marks: [], notes: [], oks: [] };
  const noteHtml = (sec) => notes.filter((n) => n.section === sec).map((n) => `<span class="note${n.sev === "critical" ? "" : " minor"}">${n.text}</span>`).join("");
  const out = [];
  let section = null;
  const flush = (sec) => { if (sec) out.push(noteHtml(sec)); };
  let titleDone = false;
  for (const b of blocks) {
    if (b.type === "title") { out.push(`<div class="ttl">${esc(b.text)}</div>`); if (!titleDone) { out.push(noteHtml("top")); titleDone = true; } continue; }
    if (b.type === "sec") { flush(section); section = b.name; out.push(`<div class="sec">${esc(b.text)}</div>`); continue; }
    const sentences = b.text.split(/(?<=[a-zà-ú)\]%0-9]\.)\s+(?=[A-ZÀ-Ú0-9"“(])/u);
    out.push(`<p class="ln">${sentences.map((s) => renderSentence(s, marks, oks)).join(" ")}</p>`);
  }
  flush(section);
  if (!titleDone) out.unshift(noteHtml("top"));
  // Notes for sections the report never had (e.g. no Impression) still show.
  const shown = new Set(blocks.filter((b) => b.type === "sec").map((b) => b.name));
  for (const sec of ["findings", "impression"]) if (!shown.has(sec)) out.push(noteHtml(sec));
  container.innerHTML = out.join("") || `<p class="ln" style="color:var(--slate)">Empty report.</p>`;
}

// ---------------------------------------------------------------- score widgets
function humanGate(g) {
  if (g === "severity cap: critical failure") return "A critical check failed, so the score is capped at 59.9.";
  if (g === "deterministic critical failure") return "The verdict is forced to FAIL, whatever the average.";
  let m = /^severity cap: severe failure weight (\d+)/.exec(g);
  if (m) return `Major failures cap the score (severity weight ${m[1]}).`;
  m = /^anti-compensation: (.+) below PASS/.exec(g);
  if (m) return `${m[1]} is below PASS, so strong form cannot lift the case to PASS.`;
  if (/no scored clinical dimension/.test(g)) return "No clinical dimension could be scored, so form alone cannot reach PASS.";
  return g;
}

function verdictStamp(r) {
  const small = r.verdict === "FAIL" && r.gateReasons.some((g) => /critical/.test(g)) ? "critical veto" : r.verdict === "PASS" ? `${r.criteriaPassed}/${r.criteriaTotal} checks` : `${r.criteriaPassed}/${r.criteriaTotal} checks`;
  return `<span class="stamp ${r.verdict}" role="img" aria-label="Verdict ${r.verdict}"><b>${r.verdict}</b><small>${esc(small)}</small></span>`;
}

function dimsHtml(r) {
  return DIM_ORDER.map((d) => {
    const v = r.dims[d];
    const verdict = r.detDims?.[d]?.verdict ?? "";
    const w = Math.round((LB.WEIGHTS[d] ?? 0) * 100);
    return `<div class="dim" title="${d}: weight ${w}%"><div class="lbl"><span>${d}</span><b>${v == null ? "n/a" : fmt1(v)}</b></div><div class="bar"><i class="${verdict}" data-w="${v == null ? 0 : v}"></i></div></div>`;
  }).join("");
}

function fillBars(scope, instant = false) {
  $$(".bar i", scope).forEach((i) => {
    const w = `${Math.max(0, Math.min(100, Number(i.dataset.w)))}%`;
    if (instant || reduceMotion) { i.style.transition = "none"; i.style.width = w; }
    else requestAnimationFrame(() => { i.style.width = w; });
  });
}

function countTo(el, from, to, ms) {
  return new Promise((resolve) => {
    if (reduceMotion || ms <= 0) { el.textContent = fmt1(to); resolve(); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt1(from + (to - from) * e);
      if (k < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

// ---------------------------------------------------------------- hero
const HERO = {
  id: "LAIBENCH-HERO-PTX",
  exam: "Chest radiograph, PA and lateral, without contrast.",
  findings: "Large right pneumothorax with partial collapse of the right lung. No pleural effusion. Cardiomediastinal silhouette within normal limits.",
  locale: "en-US",
  A: "<center><b>CHEST RADIOGRAPH, PA AND LATERAL</b></center><br><br><b>Technique</b><br>Frontal and lateral projections of the chest, acquired at full inspiration with adequate penetration.<br><br><b>Findings</b><br>The cardiac silhouette is normal in size and contour. The mediastinum and hila are unremarkable. Lung parenchyma is well expanded and clear bilaterally, without focal consolidation. Costophrenic angles are sharp, with no pleural effusion. Soft tissues and visualized osseous structures are intact.<br><br><b>Impression</b><br>No acute cardiopulmonary abnormality.",
  B: "<center><b>CHEST RADIOGRAPH</b></center><br><br><b>Technique</b><br>PA and lateral views.<br><br><b>Findings</b><br>Large right pneumothorax with partial collapse of the right lung.<br>No pleural effusion.<br>Cardiac silhouette, mediastinum and hila within normal limits. Left lung parenchyma clear. Costophrenic angles without effusion. Soft tissues intact.<br><br><b>Impression</b><br>Large right pneumothorax.",
};

async function runHero() {
  const sheets = [["#heroA", HERO.A], ["#heroB", HERO.B]];
  const results = [];
  for (const [sel, html] of sheets) {
    const r = await LB.scoreReport({ exam: HERO.exam, findings: HERO.findings, locale: HERO.locale, html, id: HERO.id });
    results.push(r);
    const sheet = $(sel);
    renderMarked($('[data-slot="report"]', sheet), html, null); // clean first; marks arrive with the verdict
    const foot = $('[data-slot="foot"]', sheet);
    foot.innerHTML = `<span class="stamp pending"><b>…</b><small>scoring</small></span>
      <div><div class="score-line"><span class="score-num" data-slot="num">0.0</span><span class="score-of">/ 100</span></div><div class="veto-line" data-slot="veto">&nbsp;</div></div>
      <div class="dims">${dimsHtml(r)}</div>`;
  }
  const play = async (sel, html, r, delay) => {
    const sheet = $(sel);
    const foot = $('[data-slot="foot"]', sheet);
    const num = $('[data-slot="num"]', foot);
    await wait(delay);
    fillBars(foot);
    const weighted = r.detOverall ?? r.score;
    await countTo(num, 0, weighted, 1100);
    if (r.verdict === "FAIL" && r.score < weighted) {
      await wait(450);
      renderMarked($('[data-slot="report"]', sheet), html, r);
      await countTo(num, weighted, r.score, 380);
      $('[data-slot="veto"]', foot).textContent = `Weighted ${fmt1(weighted)}, capped at ${fmt1(r.score)} by the critical veto`;
    } else {
      renderMarked($('[data-slot="report"]', sheet), html, r);
      $('[data-slot="veto"]', foot).innerHTML = `<span style="color:var(--slate)">${r.criteriaPassed} of ${r.criteriaTotal} checks passed</span>`;
    }
    foot.firstElementChild.outerHTML = verdictStamp(r);
  };
  const start = () => Promise.all([play("#heroA", HERO.A, results[0], 250), play("#heroB", HERO.B, results[1], 650)]);
  // One orchestrated moment: run when the duel is on screen.
  const target = $(".duel");
  if (!("IntersectionObserver" in window) || reduceMotion) { start(); return; }
  // threshold 0 + a bottom margin works on short viewports where the duel is
  // taller than the screen; the timeout guarantees the verdicts always appear.
  let started = false;
  const go = () => { if (!started) { started = true; io.disconnect(); start(); } };
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) go(); }, { threshold: 0, rootMargin: "0px 0px -25% 0px" });
  io.observe(target);
  setTimeout(go, 2500);
}

// ---------------------------------------------------------------- perturbations (same rules as scripts/public-ladder.ts)
const META = /\b(?:synthetic|harness|demonstration|for testing|testing\b|example\b|high-risk patient context)/i;
const NEG_LEAD = /^(?:no|without|negative for|absent)\b/i;
const NORMAL = /^normal study\b|^remaining\b|^scattered fibroglandular\b|\b(?:unremarkable|within (?:normal|expected) limits|normal|preserved|intact|not dilated|homogeneous|stable|patent|clear|without (?:nodules|abnormality)|recommended|advised|recommend)\b/i;
const CRIT_EN = /hemorrhag[ei]|hematoma|active\s+bleed|hemoperitoneum|hemothorax|pulmonary\s+emboli|thromboemboli|\bstroke\b|acute\s+(?:(?:cerebral|ischemic|territorial|cortical)\s+)?infarct|acute\s+(?:cerebral\s+)?ischemi|pneumothorax|aortic\s+dissection|midline\s+shift|mass\s+effect|bowel\s+obstruction|perforation|pneumoperitoneum|free\s+(?:intraperitoneal\s+)?air|\bfracture|(?:cord|spinal)\s+compression|tamponade|ruptured\s+aortic|mesenteric\s+ischemia|cauda\s+equina|torsion|necrotizing\s+fasciitis|acute\s+appendicitis/i;
const sentencesOf = (t) => t.replace(/\s*(?:,\s*)?\b(?:in|for|of)\s+the\s+example\b/gi, "").split(/(?<=[a-z)\]]\.)\s+/i).map((s) => s.trim()).filter(Boolean);
const isAbnormal = (s) => !META.test(s) && !NEG_LEAD.test(s) && !NORMAL.test(s);
const affirmsCritical = (s) => isAbnormal(s) && CRIT_EN.test(s);
function regionOf(exam) {
  const e = exam.toLowerCase();
  if (/head|brain|cranial/.test(e)) return "head";
  if (/chest|thorax|lung|pulmonary|mediastin|thoracic\s+aort/.test(e)) return "chest";
  if (/abd|pelv/.test(e)) return "abdomen";
  if (/spine|lumbar|cervical|thoracic/.test(e)) return "spine";
  return "other";
}
function perturb(kind, findings, exam) {
  const ss = sentencesOf(findings);
  const abnormal = ss.filter(isAbnormal);
  switch (kind) {
    case "reference": return { findings };
    case "omit": {
      if (!ss.some(affirmsCritical)) return { findings, hint: "This case's findings state no critical finding, so there is nothing to omit. Showing the reference report." };
      const kept = ss.filter((s) => !affirmsCritical(s));
      return { findings: kept.filter((s) => !META.test(s)).length ? kept.join(" ") : "No acute abnormality." };
    }
    case "deny": {
      const target = ss.find(affirmsCritical);
      if (!target) return { findings, hint: "This case's findings state no critical finding to deny. Showing the reference report." };
      const term = target.match(CRIT_EN)[0].toLowerCase();
      return { findings: ss.map((s) => (s === target ? `No ${term}.` : s)).join(" ") };
    }
    case "swap": {
      const target = abnormal.find((s) => /\b(?:right|left)\b/i.test(s));
      if (!target) return { findings, hint: "No abnormal finding in this case has a side to swap. Showing the reference report." };
      const swapped = target.replace(/\b(right|left)\b/i, (m) => { const to = m.toLowerCase() === "right" ? "left" : "right"; return m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to; });
      return { findings: ss.map((s) => (s === target ? swapped : s)).join(" ") };
    }
    case "fabricate": {
      const fab = { chest: [/pneumothorax/i, "Small right apical pneumothorax."], head: [/hematoma|hemorrhag/i, "Small acute subdural hematoma along the right convexity."], abdomen: [/free\s+(?:intraperitoneal\s+)?air|pneumoperitoneum|perforation/i, "Small volume of free intraperitoneal air."], spine: [/fracture/i, "Acute compression fracture of the L1 vertebral body."] };
      const [already, line] = fab[regionOf(exam)] ?? [/fracture/i, "Acute nondisplaced fracture of the right clavicle."];
      if (already.test(findings)) return { findings: `${findings.trim()} Acute nondisplaced fracture of the right clavicle.` };
      return { findings: `${findings.trim()} ${line}` };
    }
    case "null": {
      if (abnormal.length === 0) return { findings, hint: "This case is already normal. Showing the reference report." };
      return { findings: "No acute abnormality." };
    }
  }
  return { findings };
}

// ---------------------------------------------------------------- playground
const play = { cases: [], current: null, timer: null, seq: 0 };

function caseTitle(c) {
  return String(c.exam).replace(/\.$/, "").split(",").map((p) => p.trim()).filter((p) => p && !/synthetic|demonstra/i.test(p))[0] || c.label;
}

function setCase(c, start = "reference") {
  play.current = c;
  $("#caseSel").value = c.id;
  $("#examIn").value = c.exam;
  $("#findIn").value = c.findings;
  applyStart(start);
}

function applyStart(kind) {
  const exam = $("#examIn").value;
  const findings = $("#findIn").value;
  let html;
  let hint = "Starting points are built from the findings with the same rules as the public ladder.";
  if (play.current?.id === HERO.id && (kind === "hero-A" || kind === "hero-B")) {
    html = kind === "hero-A" ? HERO.A : HERO.B;
    hint = kind === "hero-A" ? "This is the polished report from the top of the page." : "This is the plain report from the top of the page.";
  } else {
    const p = perturb(kind, findings, exam);
    if (p.hint) hint = p.hint;
    html = LB.buildReferenceReport({ exam, findings: p.findings, locale: "en-US" });
  }
  $$("#starts .chip").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.start === kind)));
  $("#startHint").textContent = hint;
  $("#reportIn").value = html;
  scorePlayground();
}

function scheduleScore() { clearTimeout(play.timer); play.timer = setTimeout(scorePlayground, 180); }

async function scorePlayground() {
  const seq = ++play.seq;
  const input = { exam: $("#examIn").value, findings: $("#findIn").value, locale: "en-US", html: $("#reportIn").value, id: play.current?.id ?? "custom" };
  // The scorer runs on the main thread; keep inputs in the range real reports use.
  if (input.html.length > 30000 || input.findings.length > 6000 || input.exam.length > 600) {
    $('#result [data-slot="head"]').innerHTML = `<p class="hint">This is longer than the playground scores (report 30,000, findings 6,000, exam 600 characters). Shorten it, or run the CLI for long inputs.</p>`;
    $("#resultSummary").textContent = "Input too long to score in the browser.";
    return;
  }
  let r;
  try { r = await LB.scoreReport(input); } catch (e) { $('#result [data-slot="head"]').textContent = `The scorer could not score this input: ${e.message}`; return; }
  if (seq !== play.seq) return;
  const root = $("#result");
  const weighted = r.detOverall ?? r.score;
  $('[data-slot="head"]', root).innerHTML = `${verdictStamp(r)}
    <div><div class="score-line"><span class="score-num">${fmt1(r.score)}</span><span class="score-of">/ 100</span></div>
    <div class="${r.score < weighted - 0.05 ? "veto-line" : "score-of"}">${r.score < weighted - 0.05 ? `Weighted ${fmt1(weighted)}, capped at ${fmt1(r.score)}` : `${r.criteriaPassed} of ${r.criteriaTotal} checks passed`}</div></div>`;
  $("#resultSummary").textContent = `${r.verdict}, ${fmt1(r.score)} out of 100, ${r.checks.filter((c) => !c.passed).length} failing checks.`;
  $('[data-slot="gates"]', root).innerHTML = r.gateReasons.map((g) => `<li title="${esc(g)}">${esc(humanGate(g))}</li>`).join("");
  $('[data-slot="dims"]', root).innerHTML = dimsHtml(r);
  fillBars(root, true);
  renderMarked($('[data-slot="report"]', root), input.html, r);
  const sevRank = { critical: 0, major: 1, minor: 2 };
  const failing = r.checks.filter((c) => !c.passed).sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
  const passing = r.checks.filter((c) => c.passed);
  const row = (c) => `<div class="check"><span class="sev ${c.severity}">${c.severity}</span><span class="id">${esc(c.id)}</span><span>${esc(c.name)}${c.evidence && c.evidence !== "ok" ? `<span class="ev">${esc(c.evidence)}</span>` : ""}</span></div>`;
  $('[data-slot="checks"]', root).innerHTML = failing.length ? failing.map(row).join("") : `<p class="hint" style="padding-top:12px">Every check passes.</p>`;
  $('[data-slot="passed-summary"]', root).textContent = `Passing checks (${passing.length})`;
  $('[data-slot="passed"]', root).innerHTML = passing.map(row).join("");
}

function initPlayground(cases) {
  const heroCase = { id: HERO.id, label: "The pneumothorax test (from the top of this page)", exam: HERO.exam, findings: HERO.findings, tags: ["critical"] };
  play.cases = [heroCase, ...cases];
  const sel = $("#caseSel");
  sel.innerHTML = play.cases.map((c) => `<option value="${esc(c.id)}">${c.id === HERO.id ? esc(c.label) : `${esc(c.id.replace(/^SYN-(?:DEMO|PRO)-EN-/, "#"))}  ${esc(caseTitle(c))}`}</option>`).join("");
  sel.addEventListener("change", () => setCase(play.cases.find((c) => c.id === sel.value)));
  $$("#starts .chip").forEach((b) => b.addEventListener("click", () => applyStart(b.dataset.start)));
  ["#examIn", "#findIn", "#reportIn"].forEach((s) => $(s).addEventListener("input", () => {
    if (s !== "#reportIn") $$("#starts .chip").forEach((b) => b.setAttribute("aria-pressed", "false"));
    scheduleScore();
  }));
  $$("[data-load-hero]").forEach((a) => a.addEventListener("click", () => { setCase(heroCase, "reference"); applyStart("hero-A"); }));
  setCase(heroCase, "reference");
  applyStart("hero-A");
}

// ---------------------------------------------------------------- ladder
function statusColor(v) { return getComputedStyle(document.documentElement).getPropertyValue(v === "PASS" ? "--pass" : v === "PARTIAL" ? "--partial" : "--red").trim(); }

function drawLadder(ladder) {
  const svg = $("#ladderChart");
  const W = 1000, H = 500, ml = 40, mr = 150, mt = 30, mb = 64;
  const levels = ladder.levels;
  const plotW = W - ml - mr;
  const colW = plotW / levels.length;
  const allScores = ladder.perCase.flatMap((p) => Object.values(p.cells).filter(Boolean).map((c) => c.score));
  const yMin = Math.min(40, Math.floor((Math.min(...allScores) - 4) / 10) * 10);
  const y = (v) => mt + (100 - v) / (100 - yMin) * (H - mt - mb);
  const NS = "http://www.w3.org/2000/svg";
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  $$("g, line, rect, text, circle", svg).forEach((n) => n.remove());
  const el = (tag, attrs, parent = svg) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); parent.appendChild(n); return n; };
  const txt = (attrs, content) => { const t = el("text", { "font-family": "Hanken Grotesk, system-ui, sans-serif", ...attrs }); t.textContent = content; return t; };
  const css = getComputedStyle(document.documentElement);
  const C = { grid: css.getPropertyValue("--grid").trim(), slate: css.getPropertyValue("--slate").trim(), ink: css.getPropertyValue("--ink").trim(), surface: css.getPropertyValue("--chart").trim(), wash: css.getPropertyValue("--red-wash").trim(), red: css.getPropertyValue("--red").trim() };

  const firstCrit = levels.findIndex((l) => l.critical);
  if (firstCrit >= 0) {
    el("rect", { x: ml + firstCrit * colW + 2, y: mt - 22, width: colW * (levels.length - firstCrit) - 4, height: H - mb - mt + 22, fill: C.wash, rx: 6 });
    txt({ x: ml + firstCrit * colW + 12, y: mt - 7, fill: C.red, "font-size": 13, "font-weight": 600 }, "Critical errors");
  }
  for (let v = yMin; v <= 100; v += 10) {
    el("line", { x1: ml, x2: ml + plotW, y1: y(v), y2: y(v), stroke: C.grid, "stroke-width": 1 });
    txt({ x: ml - 8, y: y(v) + 4, "text-anchor": "end", fill: C.slate, "font-size": 12 }, String(v));
  }
  const thr = [[84, ["PASS at 84"]], [60, ["PARTIAL at 60.", "A critical veto caps", "the score at 59.9."]]];
  for (const [v, lines] of thr) {
    el("line", { x1: ml, x2: ml + plotW + 8, y1: y(v), y2: y(v), stroke: C.ink, "stroke-width": 1, opacity: .5 });
    lines.forEach((ln, k) => txt({ x: ml + plotW + 14, y: y(v) + 4 + k * 15, fill: k ? C.slate : C.ink, "font-size": 12.5, "font-weight": k ? 400 : 600 }, ln));
  }
  levels.forEach((l, i) => {
    const cx = ml + colW * (i + 0.5);
    const words = l.label.split(" ");
    const lines = words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : [l.label];
    txt({ x: cx, y: H - mb + 22, "text-anchor": "middle", fill: C.slate, "font-size": 12 }, String(i));
    lines.forEach((ln, k) => txt({ x: cx, y: H - mb + 38 + k * 14, "text-anchor": "middle", fill: C.ink, "font-size": 12.5, "font-weight": 500 }, ln));
  });

  // Column-constrained swarm: each dot stays inside its rung and as close as
  // possible to its true score; ties spread sideways first, then nudge vertically.
  const r = 4.2, pitch = 2 * r + 1.4;
  const half = colW / 2 - r - 6;
  const tip = $("#tip");
  levels.forEach((l, i) => {
    const cx = ml + colW * (i + 0.5);
    const pts = ladder.perCase.map((p) => ({ p, c: p.cells[l.id] })).filter((d) => d.c).sort((a, b) => b.c.score - a.c.score);
    const placed = [];
    const free = (x, yy) => placed.every((q) => (q.x - x) ** 2 + (q.y - yy) ** 2 >= pitch * pitch);
    for (const d of pts) {
      const py0 = y(d.c.score);
      let pos = null;
      for (let dy = 0; dy < 40 && !pos; dy++) {
        const oy = (dy % 2 ? 1 : -1) * Math.ceil(dy / 2) * pitch * 0.5;
        for (let k = 0; k < 40; k++) {
          const ox = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * pitch * 0.55;
          if (Math.abs(ox) > half) break;
          if (free(cx + ox, py0 + oy)) { pos = { x: cx + ox, y: py0 + oy }; break; }
        }
      }
      pos = pos || { x: cx, y: py0 };
      placed.push(pos);
      const g = el("g", {});
      el("circle", { cx: pos.x, cy: pos.y, r, fill: statusColor(d.c.verdict), stroke: C.surface, "stroke-width": 1.6 }, g);
      const hit = el("circle", { cx: pos.x, cy: pos.y, r: 8, fill: "transparent" }, g);
      const label = `${d.p.id}: ${d.p.label.replace(/^Synthetic\s+/i, "")}`;
      hit.addEventListener("pointerenter", (ev) => {
        tip.innerHTML = `<b>${esc(l.label)}</b><br>${esc(label)}<br>Score ${fmt1(d.c.score)}, <b>${d.c.verdict}</b>${d.c.failedCritical.length ? `<br>Critical checks failed: ${esc(d.c.failedCritical.join(", "))}` : ""}`;
        tip.style.display = "block";
        moveTip(ev);
      });
      hit.addEventListener("pointermove", moveTip);
      hit.addEventListener("pointerleave", () => { tip.style.display = "none"; });
    }
  });
  function moveTip(ev) {
    const pad = 14;
    let x = ev.clientX + pad, yy = ev.clientY + pad;
    const rect = tip.getBoundingClientRect();
    if (x + rect.width > innerWidth - 8) x = ev.clientX - rect.width - pad;
    if (yy + rect.height > innerHeight - 8) yy = ev.clientY - rect.height - pad;
    tip.style.left = `${x}px`; tip.style.top = `${yy}px`;
  }
  $("#ladderLegend").innerHTML = ["PASS", "PARTIAL", "FAIL"].map((v) => `<span><i style="background:${statusColor(v)}"></i>${v}</span>`).join("") + `<span style="color:var(--slate)">Each dot is one case; tied scores sit side by side. Hover for details.</span>`;
}

function initLadder(ladder) {
  drawLadder(ladder);
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => drawLadder(ladder));
  new MutationObserver(() => drawLadder(ladder)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const L = (id) => ladder.levels.find((l) => l.id === id);
  const ref = L("L0"), fab = L("L6"), omit = L("L5"), deny = L("L4"), nul = L("L7");
  if (ref && fab && omit && deny && nul) {
    const count = (l, rate) => Math.round((l.n * rate) / 100);
    const allOf = (l, rate) => (count(l, rate) === l.n ? `all ${l.n}` : `${count(l, rate)} of ${l.n}`);
    const caught = [fab, omit, deny, nul].every((l) => l.passRate === 0);
    $("#ladderCallout").innerHTML = `${caught ? "Every critical error on the ladder is caught." : "Critical errors on the ladder are vetoed."} <span class="muted">${fab.passRate === 0 ? "None" : count(fab, fab.passRate)} of the ${fab.n} reports with an invented critical finding ${fab.passRate === 0 ? "passes" : "pass"}; ${allOf(omit, omit.criticalVetoRate)} omitted and ${allOf(deny, deny.criticalVetoRate)} denied criticals are vetoed; ${nul.passRate === 0 ? "no" : count(nul, nul.passRate)} null report passes; and ${ref.criticalVetoRate === 0 ? "no" : count(ref, ref.criticalVetoRate)} faithful reference report is vetoed.</span>`;
  }
  const head = `<thead><tr><th class="l">Rung</th><th class="l">Error injected</th><th>Cases</th><th>Mean score</th><th>PASS</th><th>Critical veto</th></tr></thead>`;
  const rows = ladder.levels.map((l, i) => `<tr><td class="l">${i}</td><td class="l">${esc(l.label)}<br><span style="color:var(--slate);font-size:13px">${esc(l.description)}</span></td><td>${l.n}</td><td>${fmt1(l.meanScore)}</td><td class="big">${fmt1(l.passRate)}%</td><td>${fmt1(l.criticalVetoRate)}%</td></tr>`).join("");
  $("#ladderTable").innerHTML = head + `<tbody>${rows}</tbody>`;
  $("#ladderNote").textContent = `${ladder.note} Reference: ${ladder.agent}. Scorer: ${ladder.scorer}. Suite ${ladder.suite}, suiteHash ${ladder.suiteHash.slice(0, 16)}…`;
}

// ---------------------------------------------------------------- leaderboard
function gapSvg(clinical, allPass) {
  const x = (v) => 6 + (v ?? 0) * 138;
  return `<svg viewBox="0 0 150 18" aria-hidden="true"><line class="g-track" x1="6" x2="144" y1="9" y2="9" stroke-width="1"/><line class="g-span" x1="${x(allPass)}" x2="${x(clinical)}" y1="9" y2="9" stroke-width="2"/><circle class="g-all" cx="${x(allPass)}" cy="9" r="4" stroke-width="1.6"/><circle class="g-clin" cx="${x(clinical)}" cy="9" r="4.5"/></svg>`;
}

const BOARDS_META = [{ key: "pt-BR", name: "the controlled evaluation" }, { key: "en-US", name: "the public smoke test" }];

function initLeaderboard(data) {
  const notes = Object.values(data.locales || {}).map((l) => l.scoredWith).filter(Boolean);
  if (notes.length && data.currentBenchmarkVersion) {
    $("#rescore").hidden = false;
    const by = BOARDS_META.map((m) => data.locales?.[m.key]?.scoredWith ? `${m.name} with ${data.locales[m.key].scoredWith.replace(/^pre-3\.11 \(≤ (.+)\)$/, "$1 or earlier")}` : null).filter(Boolean).join(", ");
    $("#rescoreText").textContent = `Each row shows the LAIBench version that scored it: ${by}. Runs under version ${data.currentBenchmarkVersion} replace these rows as they complete.`;
  }
  const BOARDS = [
    { key: "pt-BR", title: "Controlled evaluation, first-party", sub: "Gated, aggregate-only, not external validation. The suite id says lite-public for historical reasons; its cases are not public.", prod: true, defaultKey: "clinicalScore" },
    { key: "en-US", title: "Public smoke test, open models", sub: "Synthetic and contaminable; a diagnostic baseline, not a ranking, so rows are listed alphabetically. Free endpoints are rate-limited and incomplete runs are excluded.", prod: false, defaultKey: "system" },
  ];
  const host = $("#boards");
  host.innerHTML = "";
  let disclosure = "";
  for (const b of BOARDS) {
    const loc = data.locales?.[b.key];
    if (!loc || !(loc.entries || []).length) continue;
    disclosure = loc.disclosure || disclosure;
    const div = document.createElement("div");
    div.className = "board";
    host.appendChild(div);
    const state = { key: b.defaultKey, dir: b.defaultKey === "system" ? 1 : -1 };
    const cols = [
      ["clinicalScore", "Clinical"], ["strictPass", "PASS rate"], ["allPass", "Every check passes"], ["gap", "Clinical vs every check"],
      ...DIM_ORDER.map((d) => [`dim:${d}`, d]), ["latencyMs", "Latency"],
    ];
    const val = (e, k) => (k === "system" ? e.system : k.startsWith("dim:") ? e.dims?.[k.slice(4)] : e[k]);
    const render = (focusKey) => {
      const entries = loc.entries.slice().sort((a, c) => {
        const va = val(a, state.key), vc = val(c, state.key);
        if (typeof va === "string" || typeof vc === "string") return state.dir * String(va).localeCompare(String(vc));
        if (va == null && vc == null) return 0;
        if (va == null) return 1;
        if (vc == null) return -1;
        return state.dir === -1 ? vc - va : va - vc;
      });
      const sortAttr = (k) => (state.key === k ? ` aria-sort="${state.dir === -1 ? "descending" : "ascending"}"` : "");
      const th = cols.map(([k, label]) => k === "gap"
        ? `<th class="gap">${label}<br><span style="font-size:11.5px;font-weight:400">○ every check, ● clinical</span></th>`
        : `<th${sortAttr(k)}><button type="button" data-k="${k}">${label}</button></th>`).join("");
      const tr = entries.map((e) => `<tr>
        <td class="l sys">${esc(e.system)}<span class="tag${b.prod ? " prod" : ""}">${b.prod ? "product agent" : "open model"}</span></td>
        <td class="big">${pct(e.clinicalScore)}</td>
        <td>${pct(e.strictPass)}</td>
        <td>${pct(e.allPass)}</td>
        <td class="gap">${gapSvg(e.clinicalScore, e.allPass)}</td>
        ${DIM_ORDER.map((d) => `<td>${e.dims?.[d] == null ? "—" : fmt1(e.dims[d] * 100)}<span class="mini"><i style="width:${(e.dims?.[d] ?? 0) * 100}%"></i></span></td>`).join("")}
        <td>${e.latencyMs != null ? `${fmt1(e.latencyMs / 1000)} s` : "—"}</td></tr>`).join("");
      div.innerHTML = `<h3>${esc(b.title)}</h3>
        <p class="meta">Suite id ${esc(loc.suite)}, ${esc(String(loc.cases))} cases, ${esc(loc.scoring)} scoring${loc.scoredWith ? `, scored with ${esc(loc.scoredWith.replace(/^pre-3\.11 \(≤ (.+)\)$/, "$1 or earlier"))}` : ""}. ${esc(b.sub)}</p>
        <div class="t-scroll"><table><thead><tr><th class="l"${sortAttr("system")}><button type="button" data-k="system">System</button></th>${th}</tr></thead><tbody>${tr}</tbody></table></div>
        ${b.key === "en-US" ? insight(loc.entries) : ""}`;
      $$("th button", div).forEach((btn) => btn.addEventListener("click", () => {
        if (state.key === btn.dataset.k) state.dir *= -1;
        else { state.key = btn.dataset.k; state.dir = btn.dataset.k === "system" ? 1 : -1; }
        render(btn.dataset.k);
      }));
      if (focusKey) $(`th button[data-k="${focusKey}"]`, div)?.focus();
    };
    render();
  }
  if (disclosure) host.insertAdjacentHTML("beforeend", `<p class="disclosure">${esc(disclosure)}</p>`);
}

function insight(entries) {
  const n = entries.length;
  const meanClin = entries.reduce((s, e) => s + (e.clinicalScore || 0), 0) / n;
  const maxAll = Math.max(...entries.map((e) => e.allPass || 0));
  const meanGuide = entries.reduce((s, e) => s + (e.dims?.GUIDE || 0), 0) / n;
  return `<p class="insight">Averages hide failures. These ${n} open models average ${fmt1(meanClin * 100)}% on the clinical score, yet no model has every check pass on more than ${fmt1(maxAll * 100)}% of cases. Their weakest dimension is anatomical and guideline coverage (GUIDE, mean ${fmt1(meanGuide * 100)}).</p>`;
}

// ---------------------------------------------------------------- head-to-head pilot
function initPilot(p) {
  const host = $("#pilot");
  if (!host || !p?.entries?.length) return;
  const top = p.entries[0];
  const best = p.entries.find((e) => e.kind !== "product agent");
  const minLead = p.paired.reduce((m, x) => (x.lead < m.lead ? x : m), p.paired[0]);
  const rows = p.entries.map((e, i) => `<tr class="${i === 0 ? "first" : ""}">
      <td class="l rank">${i + 1}</td>
      <td class="l sys">${esc(e.system)}${e.org && e.org !== e.system ? ` · ${esc(e.org)}` : ""}<span class="tag${e.kind === "product agent" ? " prod" : ""}">${esc(e.kind)}</span></td>
      <td class="big">${fmt1(e.meanScore)}</td>
      <td>${pct(e.passRate)} <span style="color:var(--faint)">(${fmt1(e.passCI[0] * 100)}–${fmt1(e.passCI[1] * 100)})</span></td>
      <td>${pct(e.criticalVetoRate)}</td>
      <td>${e.cases}</td></tr>`).join("");
  const pairs = p.paired.map((x) => `<tr><td class="l sys">${esc(x.versus)} · ${esc(x.org)}</td><td class="big">+${fmt1(x.lead)}</td><td>${fmt1(x.ci[0])} to ${fmt1(x.ci[1])}</td><td>${x.higher}</td><td>${x.tie}</td><td>${x.lower}</td></tr>`).join("");
  host.innerHTML = `<h3>${esc(p.title)}: ${esc(top.system)} first</h3>
    <p class="meta">${esc(p.cases)} cases, LAIBench ${esc(p.benchmarkVersion)}, ${esc(p.date)}. ${esc(p.caseSource)}</p>
    <div class="lead">
      <div><div class="k">Mean score</div><div class="v">${fmt1(top.meanScore)}</div><div class="s">Best open model: ${esc(best.system)}, ${fmt1(best.meanScore)}</div></div>
      <div><div class="k">Critical veto</div><div class="v">${pct(top.criticalVetoRate)}</div><div class="s">Reports failed by a critical error</div></div>
      <div><div class="k">Smallest paired lead</div><div class="v">+${fmt1(minLead.lead)}</div><div class="s">over ${esc(minLead.versus)}, 95% CI ${fmt1(minLead.ci[0])} to ${fmt1(minLead.ci[1])}</div></div>
    </div>
    <div class="t-scroll"><table><thead><tr><th class="l">#</th><th class="l">System</th><th>Mean score</th><th>PASS (95% CI)</th><th>Critical veto</th><th>Cases</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h4>${esc(top.system)} against each model on the same cases</h4>
    <div class="t-scroll"><table><thead><tr><th class="l">Model</th><th>Mean lead</th><th>95% CI</th><th>${esc(top.system)} higher</th><th>Tie</th><th>Lower</th></tr></thead><tbody>${pairs}</tbody></table></div>
    <p class="disclosure">${esc(p.method)} ${esc(p.scoring)} ${esc(p.disclosure)}</p>`;
  host.hidden = false;
}

// ---------------------------------------------------------------- cases explorer
const FILTERS = [
  ["all", "All", () => true],
  ["critical", "Critical finding", (c) => c.tags.some((t) => /^critical/.test(t))],
  ["laterality", "Laterality", (c) => c.tags.some((t) => /laterality/.test(t)) || /\b(?:right|left)\b/i.test(c.findings)],
  ["negation", "Negation traps", (c) => c.tags.some((t) => /negation/.test(t))],
  ["measurement", "Measurements", (c) => /\d+(?:\.\d+)?\s*(?:cm|mm)\b/.test(c.findings)],
  ["guideline", "Guideline systems", (c) => c.tags.some((t) => /birads|tirads|fleischner/i.test(t)) || /BI-RADS|TI-RADS/.test(c.findings)],
  ["normal", "Normal studies", (c) => /^normal study/i.test(c.findings.trim()) || /\bBI-RADS 1\b/.test(c.findings)],
];

function initCases(cases) {
  const host = $("#caseFilters");
  let active = "all";
  host.innerHTML = FILTERS.map(([k, label]) => `<button class="chip" type="button" data-f="${k}" aria-pressed="${k === "all"}">${label}<span style="color:var(--faint);margin-left:6px">${cases.filter(FILTERS.find((f) => f[0] === k)[2]).length}</span></button>`).join("");
  const render = () => {
    const pred = FILTERS.find((f) => f[0] === active)[2];
    $("#caseList").innerHTML = cases.filter(pred).map((c) => {
      const f = sentencesOf(c.findings).filter((s) => !META.test(s)).join(" ");
      const crit = c.tags.some((t) => /^critical/.test(t));
      const tags = [c.difficulty, ...c.tags.filter((t) => !/^(?:synthetic|demo)$/.test(t))].filter(Boolean);
      return `<button class="case" type="button" data-id="${esc(c.id)}"><span class="case-t">${esc(caseTitle(c))}</span><span class="case-f">${esc(f)}</span><span class="case-tags">${tags.map((t) => `<span class="${/^critical/.test(t) ? "crit" : ""}">${esc(t)}</span>`).join("")}<span class="case-id">${esc(c.id)}</span></span></button>`;
    }).join("");
    $$("#caseList .case").forEach((b) => b.addEventListener("click", () => {
      setCase(play.cases.find((c) => c.id === b.dataset.id));
      $("#try").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
      $("#caseSel").focus({ preventScroll: true });
    }));
  };
  $$("button", host).forEach((b) => b.addEventListener("click", () => {
    active = b.dataset.f;
    $$("button", host).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  }));
  render();
}

// ---------------------------------------------------------------- verify
function initVerify(cases, prov, data) {
  const published = data.locales?.["en-US"]?.suiteHash ?? prov?.suites?.[0]?.suiteHash;
  $("#hashBtn").addEventListener("click", () => {
    const t0 = performance.now();
    const h = LB.suiteHashFromCases(cases);
    const ms = performance.now() - t0;
    const ok = h === published;
    $("#hashOut").innerHTML = `<code class="hash ${ok ? "ok" : "bad"}">${esc(h)}</code>
      <p class="match ${ok ? "ok" : "bad"}">${ok ? "Matches the published suiteHash." : "Does not match the published suiteHash."}</p>
      <p class="hint">Computed from ${cases.length} cases in ${fmt1(ms)} ms with the same canonical hashing as the CLI.</p>`;
  });
  const bundled = LB.SCORING_HASH;
  const ok = prov && prov.scoringHash === bundled;
  $("#scoringHash").textContent = bundled;
  $("#scoringHash").classList.add(ok ? "ok" : "bad");
  $("#scoringHash").insertAdjacentHTML("afterend", `<p class="match ${ok ? "ok" : "bad"}">${ok ? `Matches provenance.json for LAIBench ${esc(prov.benchmarkVersion)}.` : "Does not match provenance.json."}</p>`);
  if (prov?.scoringFiles) {
    $("#fileHashes").innerHTML = `<table><tbody>${prov.scoringFiles.map((f) => `<tr><td class="l">${esc(f.path)}</td><td>${esc(f.sha256.slice(0, 12))}…</td></tr>`).join("")}</tbody></table>`;
  }
}

function initCopy() {
  $$("pre.cmd").forEach((pre) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      const text = pre.firstChild.textContent;
      try { await navigator.clipboard.writeText(text.trim()); btn.textContent = "Copied"; } catch { btn.textContent = "Select and copy"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 1600);
    });
    pre.appendChild(btn);
  });
}

// ---------------------------------------------------------------- boot
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

(async function boot() {
  const data = window.LAIBENCH_DATA || { locales: {} };
  initCopy();
  try { initLeaderboard(data); } catch (e) { $("#boards").textContent = `Leaderboard data could not be rendered: ${e.message}`; }
  runHero().catch((e) => { $("#heroNote").textContent = `The in-browser scorer could not start: ${e.message}`; });
  const [cases, ladder, prov] = await Promise.all([
    getJSON("cases/synthetic-demo.en-US.json").catch(() => null),
    getJSON("ladder.json").catch(() => null),
    getJSON("provenance.json").catch(() => null),
  ]);
  getJSON("pilot.json").then(initPilot).catch(() => { /* optional board */ });
  initPlayground(cases || []);
  if (cases) { initCases(cases); initVerify(cases, prov, data); }
  else $("#caseList").textContent = "The public cases could not be loaded.";
  if (ladder) initLadder(ladder);
  else $("#ladderCallout").textContent = "The ladder results could not be loaded.";
})();
