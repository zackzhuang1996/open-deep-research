import { openai } from "@ai-sdk/openai";
import { experimental_wrapLanguageModel as wrapLanguageModel } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";

import { customMiddleware } from "./custom-middleware";

export const customModel = (apiIdentifier: string) => {
  // Check which API key is available
  const hasOpenRouterKey =
    process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== "****";

  // Select the appropriate provider
  const provider = hasOpenRouterKey
    ? openrouter(apiIdentifier)
    : openai(apiIdentifier);

  return wrapLanguageModel({
    model: provider,
    middleware: customMiddleware,
  });
};
