import type { LocaleKey } from "../types.js";
import type { LocaleSpec } from "./types.js";
import { enUS } from "./en-US.js";
import { ptBR } from "./pt-BR.js";

export const LOCALES: Record<LocaleKey, LocaleSpec> = {
  "pt-BR": ptBR,
  "en-US": enUS,
};

export function getLocale(locale: LocaleKey): LocaleSpec {
  return LOCALES[locale];
}
