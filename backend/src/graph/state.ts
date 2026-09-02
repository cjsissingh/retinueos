import { Annotation } from "@langchain/langgraph";
import type { ChatMessage } from "./chat-message.js";

export const PersonaStateAnnotation = Annotation.Root({
  // Deliberately remains append-only: BaseCheckpointSaver exposes no atomic,
  // provenance-preserving prune operation, and the messages table is the
  // durable conversation record. Thread hygiene bounds the model's view with
  // the two replacement fields below instead of editing checkpoint history.
  messages: Annotation<ChatMessage[]>({
    reducer: (existing, update) => existing.concat(update),
    default: () => [],
  }),
  threadSummary: Annotation<string>({
    reducer: (_existing, update) => update,
    default: () => "",
  }),
  summarizedMessageCount: Annotation<number>({
    reducer: (_existing, update) => update,
    default: () => 0,
  }),
});

export type PersonaState = typeof PersonaStateAnnotation.State;
