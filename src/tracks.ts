import type { GeneratorAdapter, TrackId } from "./types.js";

export function defaultTrackForProvider(provider: string): TrackId {
  if (provider === "openrouter" || provider === "openai-compatible") return "mini-agent";
  if (provider === "command") return "agent";
  return "model";
}

export function resolveScaffoldId(track: TrackId, generator?: GeneratorAdapter): string | null {
  if (track === "mini-agent") return generator?.scaffoldId ?? "mini-laibench-agent-v1";
  return generator?.scaffoldId ?? null;
}
