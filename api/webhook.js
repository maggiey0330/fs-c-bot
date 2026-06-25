export const config = {
  api: {
    bodyParser: true,
  },
};

import { askClaude } from "../lib/claude.js";
import { sendMessage } from "../lib/feishu.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ message: "ok" });
  }

  const body = req.body || {};

  // 飞书验证——最优先处理，立即返回
  if (body.type === "url_verification" || body.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  // 立即返回 200，再异步处理消息
  res.status(200).end();

  try {
    if (body.header?.event_type === "im.message.receive_v1") {
      const event = body.event;
      if (event.message.message_type !== "text") return;

      const content = JSON.parse(event.message.content);
      const userText = content.text.replace(/@\S+/g, "").trim();
      const chatId = event.message.chat_id;

      const reply = await askClaude(userText);
      await sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Error:", err);
  }
}
