import type { ModelMessage } from "ai";
import type { ChatMessage } from "./chat-message.js";

function toolResultKey(toolCallId: string, toolName: string): string {
  return `${toolCallId}\u0000${toolName}`;
}

export function toModelMessages(messages: ChatMessage[]): ModelMessage[] {
  const modelMessages: ModelMessage[] = [];
  const acceptedToolResults = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const m = messages[index]!;
    if (m.role === "assistant") {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const availableResults = new Set<string>();
        for (let resultIndex = index + 1; messages[resultIndex]?.role === "tool"; resultIndex += 1) {
          const result = messages[resultIndex]!;
          if (result.toolCallId && result.toolName) {
            availableResults.add(toolResultKey(result.toolCallId, result.toolName));
          }
        }
        const completedCalls = m.toolCalls.filter((call) => availableResults.has(toolResultKey(call.id, call.name)));
        if (completedCalls.length === 0) {
          if (m.content) modelMessages.push({ role: "assistant", content: m.content });
          continue;
        }
        completedCalls.forEach((call) => acceptedToolResults.add(toolResultKey(call.id, call.name)));
        modelMessages.push({
          role: "assistant",
          content: [
            ...(m.content ? [{ type: "text" as const, text: m.content }] : []),
            ...completedCalls.map((tc) => ({
              type: "tool-call" as const,
              toolCallId: tc.id,
              toolName: tc.name,
              input: tc.arguments,
            })),
          ],
        });
        continue;
      }
      modelMessages.push({ role: "assistant", content: m.content ?? "" });
      continue;
    }
    if (m.role === "tool") {
      if (!m.toolCallId || !m.toolName || !acceptedToolResults.has(toolResultKey(m.toolCallId, m.toolName))) continue;
      acceptedToolResults.delete(toolResultKey(m.toolCallId, m.toolName));
      modelMessages.push({
        role: "tool",
        content: [
          {
            type: "tool-result" as const,
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            output: { type: "json", value: m.content ? JSON.parse(m.content) : null },
          },
        ],
      });
      continue;
    }
    modelMessages.push({ role: m.role, content: m.content ?? "" });
  }
  return modelMessages;
}
