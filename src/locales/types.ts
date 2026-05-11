import type { ExamMeta, LocaleKey, Modality, PreservationPattern, Region } from "../types.js";

export type LocaleSpec = {
  key: LocaleKey;
  name: string;
  sections: {
    analysis: RegExp;
    conclusion: RegExp;
    technique: RegExp;
  };
  sectionLabels: {
    analysis: string;
    conclusion: string;
    technique: string;
  };
  titleAbbrev: RegExp[];
  forbiddenTerms: Array<[RegExp, string]>;
  forbiddenOpeners: string[];
  contrastTerms: RegExp;
  umbrellaTerms: RegExp;
  bannedPhrases: RegExp[];
  normalPatterns: RegExp[];
  modalityVocab: {
    US_forbidden: RegExp;
    MRI_forbidden: RegExp;
    CT_forbidden: RegExp;
    CT_fix: string;
  };
  titleModalityTokens: Record<Modality, string[]>;
  titleRegionTokens: Record<Region, string[]>;
  coverage: Record<string, string[]>;
  preservationPatterns: PreservationPattern[];
  regionMap: (normalizedExam: string) => Region;
  /** Negation patterns for locale-aware negation detection in findings extraction */
  negationPatterns: RegExp[];
  buildSystemPrompt(meta: ExamMeta): string;
  judgeInstructions: string;
};
