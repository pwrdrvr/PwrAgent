/**
 * Reference prices, not the rates charged by MathOS or another model host.
 * Snapshot: GET https://openrouter.ai/api/v1/models, 2026-11-15T00:26:44Z.
 * Keep exact model/weight aliases; never guess a family, revision or free tier.
 * Where OpenRouter supplied no cache-read price, assume the full input rate.
 */
export const OPENROUTER_ASSUMED_PRICING_CATALOG_ID = "openrouter-assumed";
export const OPENROUTER_ASSUMED_PRICING_VERSION = "2026-11-15";
export const OPENROUTER_ASSUMED_MODEL_RATES = [
  {
    model: "z-ai/glm-5.3", displayModel: "Z.ai: GLM 5.3",
    aliases: ["glm-5.3", "zai-org/GLM-5.3"],
    inputUsdPerMillion: 0.084, cachedInputUsdPerMillion: 0.079, outputUsdPerMillion: 3.6,
  },
  {
    model: "z-ai/glm-5.3-flash", displayModel: "Z.ai: GLM 5.3 Flash",
    aliases: ["glm-5.3-flash", "zai-org/GLM-5.3-Flash"],
    inputUsdPerMillion: 0.0399, cachedInputUsdPerMillion: 0.03, outputUsdPerMillion: 0.0784,
  },
  {
    model: "moonshotai/kimi-k3.1-pro", displayModel: "MoonshotAI: Kimi K3.1 Pro",
    aliases: ["kimi-k3.1-pro", "moonshotai/Kimi-K3.1-Pro"],
    inputUsdPerMillion: 2.0, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10.0,
  },
  {
    model: "moonshotai/kimi-k3", displayModel: "MoonshotAI: Kimi K3",
    aliases: ["kimi-k3", "moonshotai/Kimi-K3"],
    inputUsdPerMillion: 0.192, cachedInputUsdPerMillion: 0.182, outputUsdPerMillion: 16.0,
  },
  {
    model: "deepseek/deepseek-v4.1-flash", displayModel: "DeepSeek: DeepSeek V4.1 Flash",
    aliases: ["deepseek-v4.1-flash", "deepseek-ai/DeepSeek-V4.1-Flash"],
    inputUsdPerMillion: 0.0507, cachedInputUsdPerMillion: 0.001014, outputUsdPerMillion: 0.2028,
  },
  {
    model: "meta/muse-spark-open", displayModel: "Meta: Muse Spark Open",
    aliases: ["muse-spark-open", "meta-models/Muse-Spark-Open-816B-A42B"],
    inputUsdPerMillion: 1.25, cachedInputUsdPerMillion: 0.15, outputUsdPerMillion: 4.25,
  },
  {
    model: "mistralai/mistral-large-4-0", displayModel: "Mistral: Mistral Large 4",
    aliases: ["mistral-large-4-0", "mistralai/Mistral-Large-4-1T-A52B", "mistral-large-4", "mistral-large-4.0"],
    inputUsdPerMillion: 0.7, cachedInputUsdPerMillion: 0.07, outputUsdPerMillion: 2.1,
  },
  {
    model: "nvidia/nemotron-3-ultra-550b-a55b", displayModel: "NVIDIA: Nemotron 3 Ultra",
    aliases: ["nemotron-3-ultra-550b-a55b", "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16"],
    inputUsdPerMillion: 0.6, cachedInputUsdPerMillion: 0.12, outputUsdPerMillion: 2.4,
  },
  {
    model: "nvidia/nemotron-3-super-120b-a12b", displayModel: "NVIDIA: Nemotron 3 Super",
    aliases: ["nemotron-3-super-120b-a12b", "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8"],
    inputUsdPerMillion: 0.075, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 0.4,
  },
  {
    model: "nvidia/nemotron-3-nano-30b-a3b", displayModel: "NVIDIA: Nemotron 3 Nano 30B A3B",
    aliases: ["nemotron-3-nano-30b-a3b", "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16"],
    inputUsdPerMillion: 0.06, cachedInputUsdPerMillion: 0.012, outputUsdPerMillion: 0.24,
  },
  {
    model: "thinkingmachines/inkling", displayModel: "Thinking Machines: Inkling",
    aliases: ["inkling", "thinkingmachines/Inkling"],
    inputUsdPerMillion: 1.0, cachedInputUsdPerMillion: 0.17, outputUsdPerMillion: 4.05,
  },
  {
    model: "thinkingmachines/inkling-small", displayModel: "Thinking Machines: Inkling Small",
    aliases: ["inkling-small", "thinkingmachines/Inkling-Small"],
    inputUsdPerMillion: 0.45, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 1.2,
  },
] as const;
