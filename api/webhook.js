import { askClaude } from "../lib/claude.js";
import { sendMessage } from "../lib/feishu.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body;

  // 飞书验证 URL（首次配置时需要）
  if (body.type === "url_verification") {
    return res.json({ challenge: body.challenge });
  }

  // 处理消息事件
  if (body.header?.event_type === "im.message.receive_v1") {
    const event = body.event;
    const msgType = event.message.message_type;

    if (msgType !== "text") return res.status(200).end();

    const content = JSON.parse(event.message.content);
    const userText = content.text.replace(/@\S+/g, "").trim();
    const chatId = event.message.chat_id;

    // 先返回 200，避免飞书超时重试
    res.status(200).end();

    try {
      const reply = await askClaude(userText);
      await sendMessage(chatId, reply);
    } catch (err) {
      console.error("Error:", err);
    }
  } else {
    res.status(200).end();
  }
}
