import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { model, input, previous_response_id } = req.body ?? {};

    const upstream = await fetch(`${process.env.AI_PLATFORM_URL || "https://devs.ai"}/api/v2/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model || process.env.AI_AGENT_ID,
        input,
        previous_response_id: previous_response_id || undefined,
        stream: true,
      }),
    });

    res.writeHead(upstream.status, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (!upstream.body) {
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "AI proxy error" });
  }
}
