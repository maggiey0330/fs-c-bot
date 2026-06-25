import { askClaude } from "../lib/claude.js";
import { updateBitableRecord } from "../lib/feishu.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { appToken, tableId, recordId, content } = req.body;

  if (!appToken || !tableId || !recordId || !content) {
    return res.status(400).json({ error: "缺少必要参数" });
  }

  res.status(200).json({ message: "处理中" });

  try {
    const summary = await askClaude(
      `请对以下内容做简洁摘要（100字以内）：\n${content}`
    );

    await updateBitableRecord(appToken, tableId, recordId, {
      AI摘要: summary,
    });
  } catch (err) {
    console.error("Bitable error:", err);
  }
}
