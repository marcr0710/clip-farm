export type Message = { role: "user" | "assistant"; content: string };

export type SendOptions = {
  /** Agent/model id to talk to. Omit to use the app's primary agent. */
  model?: string;
  /** Response id of the previous turn (server-side conversation memory). Omit to start fresh. */
  previousResponseId?: string | null;
};

// Sends ONE user message. The server keeps conversation history, so you pass
// only the latest text plus the previous response id — never the whole history.
// onComplete fires once the turn settles: with the new response id ONLY when
// the turn actually completed (or was truncated as incomplete), or with null
// when it aborted/ended without a response.completed / response.incomplete
// event. Store a non-null id and pass it back as
// opts.previousResponseId on the next call; on null, KEEP the previous id so an
// aborted turn doesn't corrupt the server-side conversation thread.
export async function sendMessage(
  input: string,
  opts: SendOptions,
  onDelta: (text: string) => void,
  onComplete: (responseId: string | null) => void,
  onError: (err: string) => void,
  signal?: AbortSignal,
) {
  let responseId: string | null = null;
  // Exactly one of onComplete/onError fires, no matter how the stream ends
  // (normal completion, max_output_tokens truncation via response.incomplete,
  // the connection closing WITHOUT a terminal success event, a network error,
  // or an abort). This is what keeps the caller's isLoading from getting stuck on.
  let settled = false;
  const finish = (id: string | null) => { if (!settled) { settled = true; onComplete(id); } };
  const fail = (msg: string) => { if (!settled) { settled = true; onError(msg); } };

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input,
        model: opts.model,
        previous_response_id: opts.previousResponseId ?? undefined,
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      fail("Request failed: " + res.status);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let currentData = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          currentData = line.slice(6);
        } else if (line.startsWith(":")) {
          // SSE comment (keep-alive), ignore
        } else if (line === "") {
          if (currentEvent && currentData && currentData !== "[DONE]") {
            try {
              const parsed = JSON.parse(currentData);
              if (currentEvent === "response.output_text.delta") {
                if (typeof parsed.delta === "string") onDelta(parsed.delta);
              } else if (
                currentEvent === "response.created" ||
                currentEvent === "response.completed" ||
                currentEvent === "response.incomplete"
              ) {
                if (parsed.response?.id) responseId = parsed.response.id;
                if (currentEvent === "response.completed" || currentEvent === "response.incomplete") {
                  finish(responseId);
                }
              } else if (currentEvent === "response.failed") {
                fail(parsed.response?.error?.message || "Stream error");
              }
            } catch { /* skip malformed JSON */ }
          }
          currentEvent = "";
          currentData = "";
        }
      }
    }
  } catch (err) {
    // A user-initiated abort isn't an error — just settle so loading clears.
    if (!signal?.aborted) fail(err instanceof Error ? err.message : "Stream error");
  } finally {
    // Stream ended/aborted without a terminal event — settle with null so the
    // caller clears loading WITHOUT advancing previousResponseId to a response
    // that never completed. (No-op if response.completed/incomplete/failed already fired.)
    finish(null);
  }
}
