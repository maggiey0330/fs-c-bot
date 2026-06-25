import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";

const app = express();
app.use(express.json());

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function getTenantToken() {
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }
  );
  return res.data.tenant_access_token;
}

app.get("/", (req, res) => res.send("ok"));

app.post("/api/webhook", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  res.status(200).end();

  if (body.header?.event_type === "im.message.receive_v1") {
    try {
      const event = body.event;
      if (event.message.message_type !== "text") return;

      const content = JSON.parse(event.message.content);
      const userText = content.text.replace(/@\S+/g, "").trim();
      const chatId = event.message.chat_id;

      const reply = await claude.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: "你是一个智能助手，请用中文回答。",
        messages: [{ role: "user", content: userText }],
      });

      const token = await getTenantToken();
      await axios.post(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
        { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: reply.content[0].text }) },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch (err) {
      console.error("Error:", err);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
