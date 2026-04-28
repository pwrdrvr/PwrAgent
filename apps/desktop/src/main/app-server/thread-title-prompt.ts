import threadTitlePrompt from "./thread-title-prompt.md?raw";

const USER_PROMPT_PLACEHOLDER = "{{USER_PROMPT}}";

export function readThreadTitlePrompt(): string {
  return threadTitlePrompt;
}

export function buildThreadTitlePrompt(userPrompt: string): string {
  return threadTitlePrompt.replace(USER_PROMPT_PLACEHOLDER, userPrompt.trim());
}
