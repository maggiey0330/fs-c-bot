export const config = {
  runtime: "edge",
};

export default async function handler(req) {
  if (req.method === "GET") {
    return new Response(JSON.stringify({ message: "ok" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await req.json();

  // 飞书验证——立即返回
  if (body.type === "url_verification" || body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // 立即返回 200，异步处理消息
  const response = new Response("ok", { status: 200 });

  // 异步处理（不阻塞返回）
  if (body.header?.event_type === "im.message.receive_v1") {
    const event = body.event;
    if (event.message.message_type === "text") {
      const content = JSON.parse(event.message.content);
      const userText = content.text.replace(/@\S+/g, "").trim();
      const chatId = event.message.chat_id;

      // 调用 Claude
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: "你是一个智能助手，请用中文回答。",
          messages: [{ role: "user", content: userText }],
        }),
      })
        .then((r) => r.json())
        .then(async (data) => {
          const reply = data.content[0].text;

          // 获取飞书 token
          const tokenRes = await fetch(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                app_id: process.env.FEISHU_APP_ID,
                app_secret: process.env.FEISHU_APP_SECRET,
              }),
            }
          );
          const tokenData = await tokenRes.json();
          const token = tokenData.tenant_access_token;

          // 发送回复
          await fetch(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                receive_id: chatId,
                msg_type: "text",
                content: JSON.stringify({ text: reply }),
              }),
            }
          );
        })
        .catch(console.error);
    }
  }

  return response;
}
