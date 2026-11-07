/**
 * Shared ladder definitions: rungs and the one-error-per-rung perturbations.
 * Used by scripts/public-ladder.ts (scores the ladder with the real scorer) and
 * scripts/decision-calibrate.ts (uses the same rungs as ground truth to
 * calibrate the decision judge). Keep in one place so both see identical reports.
 */
import { abnormalInputClauses } from "../src/evaluators/source-findings.ts";

export type Rung = { id: string; label: string; description: string; critical: boolean };

export const RUNGS: Rung[] = [
  { id: "L0", label: "Reference", description: "Faithful restructuring of the input findings.", critical: false },
  { id: "L1", label: "Measurement drift", description: "The first measurement is changed (e.g. 7 mm → 8 mm).", critical: false },
  { id: "L2", label: "Non-critical omission", description: "One non-critical abnormal finding is dropped.", critical: false },
  { id: "L3", label: "Laterality swap", description: "The first right/left in an abnormal finding is swapped.", critical: false },
  { id: "L4", label: "Critical denied", description: "The input's critical finding is written as absent (\"No pneumothorax.\").", critical: true },
  { id: "L5", label: "Critical omitted", description: "Every sentence carrying an input critical finding is dropped; the rest stays polished.", critical: true },
  { id: "L6", label: "Critical fabricated", description: "A plausible critical finding the input never states is added.", critical: true },
  { id: "L7", label: "Null report", description: "\"No acute abnormality.\" written for an abnormal study.", critical: true },
];


// ---- sentence helpers (same splitting as the reference agent) ----
export const META = /\b(?:synthetic|harness|demonstration|for testing|testing\b|example\b|high-risk patient context)/i;
export function sentences(text: string): string[] {
  return text.replace(/\s*(?:,\s*)?\b(?:in|for|of)\s+the\s+example\b/gi, "").split(/(?<=[a-z)\]]\.)\s+/i).map((s) => s.trim()).filter(Boolean);
}
export const NEG_LEAD = /^(?:no|without|negative for|absent)\b/i;
export const NORMAL = /^normal study\b|^remaining\b|^scattered fibroglandular\b|\b(?:unremarkable|within (?:normal|expected) limits|normal|preserved|intact|not dilated|homogeneous|stable|patent|clear|without (?:nodules|abnormality)|recommended|advised|recommend)\b/i;
export const CRIT_EN = /hemorrhag[ei]|hematoma|active\s+bleed|hemoperitoneum|hemothorax|pulmonary\s+emboli|thromboemboli|\bstroke\b|acute\s+(?:(?:cerebral|ischemic|territorial|cortical)\s+)?infarct|acute\s+(?:cerebral\s+)?ischemi|pneumothorax|aortic\s+dissection|midline\s+shift|mass\s+effect|bowel\s+obstruction|perforation|pneumoperitoneum|free\s+(?:intraperitoneal\s+)?air|\bfracture|(?:cord|spinal)\s+compression|tamponade|ruptured\s+aortic|mesenteric\s+ischemia|cauda\s+equina|torsion|necrotizing\s+fasciitis|acute\s+appendicitis/i;
export const isMeta = (s: string) => META.test(s);
// A sentence is abnormal only if the scorer's own rule agrees (postfix negation such
// as "Lung fields without focal opacities" is a normal statement), so a null report
// is only ever injected into a study that actually has an abnormal finding.
export const isAbnormal = (s: string) => !isMeta(s) && !NEG_LEAD.test(s) && !NORMAL.test(s) && abnormalInputClauses(s, "en-US").length > 0;
export const affirmsCritical = (s: string) => isAbnormal(s) && CRIT_EN.test(s);

export function perturb(rung: string, findings: string, region: string): string | null {
  const ss = sentences(findings);
  const abnormal = ss.filter(isAbnormal);
  switch (rung) {
    case "L0": return findings;
    case "L1": {
      const rx = /(\d+(?:\.\d+)?)(\s*)(cm|mm)\b/;
      if (!rx.test(findings)) return null;
      return findings.replace(rx, (_m, v: string, sp: string, u: string) => {
        const n = Number(v);
        const next = v.includes(".") ? (n + 0.5).toFixed(1) : String(n >= 10 ? n + 3 : n + 1);
        return `${next}${sp}${u}`;
      });
    }
    case "L2": {
      const nonCrit = abnormal.filter((s) => !CRIT_EN.test(s));
      if (nonCrit.length === 0 || abnormal.length < 2) return null; // keep ≥1 abnormal sentence
      const drop = nonCrit[nonCrit.length - 1];
      return ss.filter((s) => s !== drop).join(" ");
    }
    case "L3": {
      const target = abnormal.find((s) => /\b(?:right|left)\b/i.test(s));
      if (!target) return null;
      const swapped = target.replace(/\b(right|left)\b/i, (m) => {
        const to = m.toLowerCase() === "right" ? "left" : "right";
        return m[0] === m[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1) : to;
      });
      return ss.map((s) => (s === target ? swapped : s)).join(" ");
    }
    case "L4": {
      const target = ss.find(affirmsCritical);
      if (!target) return null;
      const term = target.match(CRIT_EN)![0].toLowerCase();
      return ss.map((s) => (s === target ? `No ${term}.` : s)).join(" ");
    }
    case "L5": {
      if (!ss.some(affirmsCritical)) return null;
      const kept = ss.filter((s) => !affirmsCritical(s));
      return kept.filter((s) => !isMeta(s)).length ? kept.join(" ") : "No acute abnormality.";
    }
    case "L6": {
      const fab: Record<string, [RegExp, string]> = {
        chest: [/pneumothorax/i, "Small right apical pneumothorax."],
        head: [/hematoma|hemorrhag|(?:hyperattenuating|hyperdense)\s+(?:\S+\s+){0,2}?(?:extra-?axial|subdural|epidural)\s+collection/i, "Small acute subdural hematoma along the right convexity."],
        abdomen: [/free\s+(?:intraperitoneal\s+)?air|pneumoperitoneum|perforation/i, "Small volume of free intraperitoneal air."],
        pelvis: [/free\s+(?:intraperitoneal\s+)?air|pneumoperitoneum|perforation/i, "Small volume of free intraperitoneal air."],
        spine: [/fracture/i, "Acute compression fracture of the L1 vertebral body."],
      };
      const [already, line] = fab[region] ?? [/fracture/i, "Acute nondisplaced fracture of the right clavicle."];
      if (already.test(findings)) return null;
      return `${findings.trim()} ${line}`;
    }
    case "L7": {
      if (abnormal.length === 0) return null;
      return "No acute abnormality.";
    }
  }
  return null;
}

export function regionOf(exam: string): string {
  const e = exam.toLowerCase();
  if (/thyroid/.test(e)) return "thyroid";
  if (/breast|mammo/.test(e)) return "breast";
  if (/pelv/.test(e)) return "pelvis";
  if (/head|brain|cranial/.test(e)) return "head";
  if (/chest|thorax|lung|pulmonary|mediastin|thoracic\s+aort/.test(e)) return "chest";
  if (/abd/.test(e)) return "abdomen";
  if (/spine|lumbar|cervical|thoracic|knee/.test(e)) return "spine";
  return "other";
}
