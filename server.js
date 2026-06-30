import express from "express";
import axios from "axios";
import crypto from "crypto";
import cron from "node-cron";

const app = express();
app.use(express.json());

const {
  DEEPSEEK_API_KEY,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  XGJ_APP_KEY,
  XGJ_APP_SECRET,
  BITABLE_APP_TOKEN,
} = process.env;

const TABLE_ID = "tbl6UaoSCJ0aR7pE";
const AUTHORIZE_ID = 823431263780933;

// ── 飞书 ──
async function getLarkToken() {
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET }
  );
  return res.data.tenant_access_token;
}

async function sendLarkMessage(chatId, text) {
  const token = await getLarkToken();
  await axios.post(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

async function larkRequest(token, method, path, body) {
  const res = await axios({
    method,
    url: `https://open.feishu.cn/open-apis${path}`,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: body,
  });
  return res.data;
}

// ── DeepSeek ──
async function askDeepSeek(userMessage) {
  const res = await axios.post(
    "https://api.deepseek.com/chat/completions",
    {
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "你是花臂大咪小卖部的理货助手，请用中文简洁回答。" },
        { role: "user", content: userMessage },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return res.data.choices[0].message.content;
}

// ── 闲管家 ──
async function xgjPost(path, body = {}) {
  const bodyString = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyMd5 = crypto.createHash("md5").update(bodyString).digest("hex");
  const sign = crypto.createHash("md5")
    .update(`${XGJ_APP_KEY},${bodyMd5},${timestamp},${XGJ_APP_SECRET}`)
    .digest("hex");
  const url = `https://open.goofish.pro/api/open${path}?appid=${XGJ_APP_KEY}&timestamp=${timestamp}&sign=${sign}`;
  const res = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
  });
  if (res.data.code !== 0) throw new Error(`闲管家错误: ${res.data.msg}`);
  return res.data.data;
}

// ── 查货号 ──
async function queryProductByKeyword(keyword) {
  const token = await getLarkToken();
  const data = await larkRequest(token, "GET",
    `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records?page_size=10&filter=CurrentValue.[商品标题].contains("${keyword}")`
  );
  return data.data?.items || [];
}

// ── 同步逻辑 ──
async function syncProducts() {
  console.log(`[${new Date().toLocaleString("zh-CN")}] 开始同步...`);
  const token = await getLarkToken();

  // 1. 拉闲管家销售中商品
  let allProducts = [], page = 1;
  while (true) {
    const result = await xgjPost("/product/list", {
      authorize_id: AUTHORIZE_ID,
      product_status: 22,
      page_no: page,
      page_size: 50,
    });
    allProducts = allProducts.concat(result.list || []);
    if (allProducts.length >= result.count || (result.list?.length || 0) < 50) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`闲管家销售中: ${allProducts.length} 件`);

  // 2. 查飞书现有记录
  const existingMap = {};
  let pageToken = "";
  while (true) {
    const url = `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500${pageToken ? "&page_token=" + pageToken : ""}`;
    const data = await larkRequest(token, "GET", url);
    if (!data.data?.items) break;
    data.data.items.forEach(r => {
      const pid = r.fields["闲鱼商品ID"];
      if (pid) existingMap[String(pid)] = r.record_id;
    });
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  // 3. 删除已下架
  const activeIds = new Set(allProducts.map(p => String(p.product_id)));
  const toDeleteIds = Object.keys(existingMap).filter(pid => !activeIds.has(pid));
  if (toDeleteIds.length > 0) {
    for (let i = 0; i < toDeleteIds.length; i += 500) {
      const batch = toDeleteIds.slice(i, i + 500).map(pid => existingMap[pid]);
      await larkRequest(token, "POST",
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records/batch_delete`,
        { records: batch }
      );
    }
    console.log(`已删除下架商品: ${toDeleteIds.length} 条`);
  }

  // 4. 新增 or 更新
  let created = 0, updated = 0;
  for (let i = 0; i < allProducts.length; i += 10) {
    const batch = allProducts.slice(i, i + 10);
    const toCreate = [], toUpdate = [];
    batch.forEach(p => {
      const pid = String(p.product_id);
      const fields = {
        "闲鱼商品ID": pid,
        "商品标题": p.title,
        "售价": p.price / 100,
        "库存": p.stock,
        "商品状态": "销售中",
        "上架时间": p.online_time
          ? new Date(p.online_time * 1000).toISOString().replace("T", " ").slice(0, 19)
          : "",
      };
      existingMap[pid]
        ? toUpdate.push({ record_id: existingMap[pid], fields })
        : toCreate.push({ fields });
    });

    if (toCreate.length) {
      await larkRequest(token, "POST",
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records/batch_create`,
        { records: toCreate }
      );
      created += toCreate.length;
    }
    if (toUpdate.length) {
      await larkRequest(token, "POST",
        `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records/batch_update`,
        { records: toUpdate }
      );
      updated += toUpdate.length;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`✅ 同步完成！新增: ${created} 更新: ${updated} 删除: ${toDeleteIds.length}`);
  const NOTIFY_CHAT_ID = "oc_564a686f2219aec81155ef7ce5212978";
  await sendLarkMessage(NOTIFY_CHAT_ID, `✅ 库存同步完成！\n更新: ${updated} 件  新增: ${created} 件  删除: ${toDeleteIds.length} 件\n同步时间: ${new Date().toLocaleString("zh-CN")}`);
}

// ── 待发货提醒 ──
const OVERDUE_HOURS = 24; // 超过多少小时未发货算超时
const remindedToday = {}; // 记录：{ "2026/6/30": Set(order_no) }，按天去重，重启会清空

async function checkPendingShipments() {
  console.log(`[${new Date().toLocaleString("zh-CN")}] 开始检查待发货订单...`);
  const NOTIFY_CHAT_ID = "oc_564a686f2219aec81155ef7ce5212978";
  const now = Math.floor(Date.now() / 1000);
  const overdueSeconds = OVERDUE_HOURS * 3600;
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (!remindedToday[today]) remindedToday[today] = new Set();

  // 1. 拉待发货订单
  const result = await xgjPost("/order/list", {
    authorize_id: AUTHORIZE_ID,
    order_status: 22, // 待发货/已售出
    page_no: 1,
    page_size: 50,
  });
  const allOrders = result.list || [];

  // 状态码为主判断，取消/退款字段做兜底校验
  const pending = allOrders.filter(o =>
    o.order_status === 22 &&
    (!o.cancel_time || o.cancel_time === 0) &&
    (!o.refund_status || o.refund_status === 0)
  );

  // 筛选：超时 + 今天还没提醒过
  const toRemind = pending.filter(o => {
    const elapsed = now - o.pay_time;
    return elapsed >= overdueSeconds && !remindedToday[today].has(o.order_no);
  });

  if (toRemind.length === 0) {
    console.log("没有需要提醒的待发货订单");
    return "✅ 没有超时未发货的订单";
  }

  // 2. 查飞书商品表，拿货架号（按 product_id 关联）
  const token = await getLarkToken();
  const shelfMap = {}; // { product_id: 货架位置 }
  let pageToken = "";
  while (true) {
    const url = `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500${pageToken ? "&page_token=" + pageToken : ""}`;
    const data = await larkRequest(token, "GET", url);
    if (!data.data?.items) break;
    data.data.items.forEach(r => {
      const pid = r.fields["闲鱼商品ID"];
      if (pid) shelfMap[String(pid)] = r.fields["货架位置"] || "未设置";
    });
    if (!data.data.has_more) break;
    pageToken = data.data.page_token;
  }

  // 3. 拼提醒消息
  const dateStr = today.replace(/\//g, "-"); // yyyy-mm-dd 格式
  const lines = toRemind.map((o, i) => {
    const pid = String(o.goods?.product_id || "");
    const title = o.goods?.title || "未知商品";
    const qty = o.goods?.quantity || 1;
    const shelf = shelfMap[pid] || "未设置";
    return `第 ${i + 1} 件\n${title} - ${qty}件 - 货架${shelf}`;
  });

  const message = `📦 ${dateStr} 待发货提醒: 共计 ${toRemind.length} 个订单\n--\n${lines.join("\n\n")}`;
  await sendLarkMessage(NOTIFY_CHAT_ID, message);

  toRemind.forEach(o => remindedToday[today].add(o.order_no));
  console.log(`✅ 已发送待发货提醒: ${toRemind.length} 单`);
  return message;
}

// ── 定时任务：每天早上9点（上海时间）同步库存 ──
cron.schedule("0 9 * * *", () => {
  syncProducts().catch(console.error);
}, { timezone: "Asia/Shanghai" });

// ── Webhook ──
app.get("/", (req, res) => res.send("ok"));

app.post("/api/webhook", async (req, res) => {
  const body = req.body;

  if (body.type === "url_verification" || body.challenge) {
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
      console.log("chat_id:", chatId);

      // 手动触发待发货检查（必须放在查货号正则之前，否则"查待发货"会被当成关键词搜索拦截）
      if (userText === "查待发货") {
        await sendLarkMessage(chatId, "⏳ 正在检查待发货订单...");
        await checkPendingShipments();
        return;
      }

      // 手动触发同步
      if (userText === "同步库存") {
        await sendLarkMessage(chatId, "⏳ 开始同步，请稍候...");
        await syncProducts();
        await sendLarkMessage(chatId, "✅ 库存同步完成！");
        return;
      }

      // 查货号：「查 BKM」「货号 SANR」
      const queryMatch = userText.match(/^(查|货号|查询)\s*(.+)/);
      if (queryMatch) {
        const keyword = queryMatch[2].trim();
        const records = await queryProductByKeyword(keyword);
        if (records.length === 0) {
          await sendLarkMessage(chatId, `❌ 没找到「${keyword}」相关商品`);
        } else {
          const lines = records.map(r => {
            const f = r.fields;
            return `📦 ${f["商品标题"]}\n库存: ${f["库存"]}  售价: ¥${f["售价"]}\n货架: ${f["货架位置"] || "未设置"}`;
          });
          await sendLarkMessage(chatId, lines.join("\n\n"));
        }
        return;
      }

      // 普通对话
      const reply = await askDeepSeek(userText);
      await sendLarkMessage(chatId, reply);

    } catch (err) {
      console.error("Error:", err);
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
