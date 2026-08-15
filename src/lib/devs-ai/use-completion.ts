import { useCallback, useState } from "react";
import { sendMessage } from "./client";

export function useCompletion(opts?: { model?: string }) {
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useCallback(async (prompt: string) => {
    setResult("");
    setError(null);
    setIsLoading(true);
    let assembled = "";

    await sendMessage(
      prompt,
      { model: opts?.model, previousResponseId: undefined },
      (delta) => {
        assembled += delta;
        setResult(assembled);
      },
      () => {
        setResult(assembled);
        setIsLoading(false);
      },
      (err) => {
        setError(err);
        setIsLoading(false);
      },
    );

    return assembled;
  }, [opts?.model]);

  return { complete, result, isLoading, error };
}
