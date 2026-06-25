app.post("/api/webhook", async (req, res) => {
  const body = req.body;
  
  console.log("收到请求:", JSON.stringify(body));

  // 飞书验证
  if (body.type === "url_verification") {
    console.log("验证请求, challenge:", body.challenge);
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body.challenge) {
    return res.status(200).json({ challenge: body.challenge });
  }

  res.status(200).end();

  if (body.header?.event_type === "im.message.receive_v1") {
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
  }
});
