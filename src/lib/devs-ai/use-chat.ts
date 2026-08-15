import { useState, useRef, useCallback } from "react";
import { sendMessage, type Message } from "./client";

// Pass a `model` (agent/model id) to choose which linked agent to talk to.
// Conversation memory is server-side: the hook tracks the previous response id
// and sends only the latest message. Use ONE useChat per agent so each agent
// keeps its own thread; `reset()` starts a fresh conversation.
export function useChat(opts?: { model?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const previousResponseIdRef = useRef<string | null>(null);

  const send = useCallback(async (text: string) => {
    setError(null);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);
    setIsLoading(true);
    abortRef.current = new AbortController();
    let assembled = "";
    await sendMessage(
      text,
      { model: opts?.model, previousResponseId: previousResponseIdRef.current },
      (delta) => {
        assembled += delta;
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", content: assembled };
          return updated;
        });
      },
      (responseId) => {
        // Only advance the thread pointer on a genuinely completed turn; an
        // aborted/incomplete turn yields null and must keep the last good id.
        if (responseId) previousResponseIdRef.current = responseId;
        setIsLoading(false);
      },
      (err) => { setError(err); setIsLoading(false); },
      abortRef.current.signal,
    );
  }, [opts?.model]);

  const abort = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    previousResponseIdRef.current = null;
    setMessages([]);
    setError(null);
  }, []);

  return { messages, sendMessage: send, isLoading, error, abort, reset };
}
