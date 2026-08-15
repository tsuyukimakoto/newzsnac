import type { Fetch } from "../sources/resolver.js";

export async function listLocalModels(endpoint: URL, fetcher: Fetch = globalThis.fetch): Promise<readonly string[]> {
  const url = new URL(`${endpoint.pathname.replace(/\/$/, "")}/models`, endpoint);
  const response = await fetcher(url, { signal: AbortSignal.timeout(1_000) });
  if (!response.ok) throw new Error(`LM Studio returned HTTP ${response.status}`);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  return (body.data ?? []).flatMap((model) => model.id ? [model.id] : []);
}

export function selectLoadedModel(configuredModel: string, models: readonly string[]): string {
  const exact = models.find((model) => model.toLowerCase() === configuredModel.toLowerCase());
  if (exact) return exact;
  const matches = models.filter((model) => model.toLowerCase().includes(configuredModel.toLowerCase()));
  return matches[0] ?? configuredModel;
}
