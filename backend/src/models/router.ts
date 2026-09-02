import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export function resolveModel(provider: string, modelName: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return anthropic(modelName);
    case "openai":
      return openai.responses(modelName);
    default:
      throw new Error(`unsupported model provider: ${provider}`);
  }
}
