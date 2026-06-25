import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function askClaude(userMessage, systemPrompt = "") {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemPrompt || "你是一个智能助手，请用中文回答。",
    messages: [{ role: "user", content: userMessage }],
  });
  return response.content[0].text;
}
