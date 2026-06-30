import express from "express";
import axios from "axios";
import crypto from "crypto";
import cron from "node-cron";
import dotenv from "dotenv";
import { WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";

dotenv.config();

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

// ── 查询订单详情（按订单号，用来诊断/校验某个订单的真实状态）──
async function getOrderDetail(orderNo) {
  return xgjPost("/order/detail", { order_no: orderNo });
}

// ── 查货号 ──
async function queryProductByKeyword(keyword) {
  const safeKeyword = keyword.replace(/["\\]/g, "");
  const token = await getLarkToken();
  const data = await larkRequest(token, "GET",
    `/bitable/v1/apps/${BITABLE_APP_TOKEN}/tables/${TABLE_ID}/records?page_size=10&filter=CurrentValue.[商品标题].contains("${safeKeyword}")`
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

const ORDER_STATUS_TEXT = {
  11: "待付款", 12: "待发货", 21: "已发货", 22: "已完成", 23: "已退款", 24: "已关闭",
};

// ── 待发货提醒 ──
const OVERDUE_HOURS = 24; // 超过多少小时未发货算超时
const remindedToday = {}; // 记录：{ "2026/6/30": Set(order_no) }，按天去重，重启会清空

// 拉取所有"待发货"且未取消未退款的订单（带分页保护，避免超过100条漏单）
async function fetchPendingOrders() {
  let allOrders = [], page = 1;
  while (true) {
    const result = await xgjPost("/order/list", {
      authorize_id: AUTHORIZE_ID,
      order_status: 12, // 12 = 待发货（已付款、未发货）
      page_no: page,
      page_size: 100,
    });
    const list = result.list || [];
    allOrders = allOrders.concat(list);
    if (allOrders.length >= result.count || list.length < 100) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`📋 接口返回待发货订单(order_status=12): ${allOrders.length} 条，authorize_id=${AUTHORIZE_ID}`);

  const pending = allOrders.filter(o =>
    o.order_status === 12 &&
    (!o.cancel_time || o.cancel_time === 0) &&
    (!o.refund_status || o.refund_status === 0)
  );
  console.log(`📋 排除取消/退款后剩余: ${pending.length} 条`);
  return pending;
}

// 给一批订单拼带货架号的提醒文案
async function buildOrderListMessage(orders, title) {
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

  const lines = orders.map((o, i) => {
    const pid = String(o.goods?.product_id || "");
    const title2 = o.goods?.title || "未知商品";
    const qty = o.goods?.quantity || 1;
    const shelf = shelfMap[pid] || "未设置";
    return `第 ${i + 1} 件\n${title2} - ${qty}件 - 货架${shelf}`;
  });

  return `${title}: 共计 ${orders.length} 个订单\n--\n${lines.join("\n\n")}`;
}

// 定时任务调用：只提醒"超过 OVERDUE_HOURS 小时未发货 且 今天还没提醒过"的订单
async function checkPendingShipments() {
  console.log(`[${new Date().toLocaleString("zh-CN")}] 开始检查待发货订单...`);
  const NOTIFY_CHAT_ID = "oc_564a686f2219aec81155ef7ce5212978";
  const now = Math.floor(Date.now() / 1000);
  const overdueSeconds = OVERDUE_HOURS * 3600;
  const today = new Date().toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (!remindedToday[today]) remindedToday[today] = new Set();

  const pending = await fetchPendingOrders();

  const toRemind = pending.filter(o => {
    const elapsed = now - o.pay_time;
    return elapsed >= overdueSeconds && !remindedToday[today].has(o.order_no);
  });
  console.log(`📋 其中超过${OVERDUE_HOURS}小时未发货且今天未提醒过的: ${toRemind.length} 条`);

  if (toRemind.length === 0) {
    const msg = pending.length > 0
      ? `✅ 当前有 ${pending.length} 个待发货订单，但都还没超过 ${OVERDUE_HOURS} 小时，暂不需要提醒`
      : "✅ 没有待发货订单";
    console.log(msg);
    await sendLarkMessage(NOTIFY_CHAT_ID, msg);
    return msg;
  }

  const dateStr = today.replace(/\//g, "-"); // yyyy-mm-dd 格式
  const message = await buildOrderListMessage(toRemind, `📦 ${dateStr} 超时未发货提醒`);
  await sendLarkMessage(NOTIFY_CHAT_ID, message);

  toRemind.forEach(o => remindedToday[today].add(o.order_no));
  console.log(`✅ 已发送待发货提醒: ${toRemind.length} 单`);
  return message;
}

// 手动指令「查待发货」调用：不看超时，直接列出当前所有待发货订单
async function listAllPendingShipments(chatId) {
  const pending = await fetchPendingOrders();
  if (pending.length === 0) {
    await sendLarkMessage(chatId, "✅ 当前没有待发货订单");
    return;
  }
  const message = await buildOrderListMessage(pending, "📦 当前待发货订单");
  await sendLarkMessage(chatId, message);
}

// ── 定时任务：每天早上9点（上海时间）同步库存 ──
cron.schedule("0 9 * * *", () => {
  syncProducts().catch(console.error);
}, { timezone: "Asia/Shanghai" });

// ── 定时任务：每小时检查一次待发货超时订单 ──
cron.schedule("0 * * * *", () => {
  checkPendingShipments().catch(console.error);
}, { timezone: "Asia/Shanghai" });

// ── 消息去重：飞书在网络抖动/处理较慢时可能重复投递同一条事件 ──
const processedMessageIds = new Map(); // message_id -> 处理时间戳
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10分钟内的重复消息直接丢弃

function isDuplicateMessage(messageId) {
  if (!messageId) return false; // 没有 message_id 就不做去重，正常处理
  const now = Date.now();
  // 顺手清理过期记录，避免 Map 无限增长
  for (const [id, ts] of processedMessageIds) {
    if (now - ts > DEDUP_WINDOW_MS) processedMessageIds.delete(id);
  }
  if (processedMessageIds.has(messageId)) return true;
  processedMessageIds.set(messageId, now);
  return false;
}

// ── 收到一条文本消息时的处理逻辑（被长连接的事件回调调用） ──
async function handleTextMessage(event) {
  try {
    if (event.message.message_type !== "text") return;

    const messageId = event.message.message_id;
    if (isDuplicateMessage(messageId)) {
      console.log("⚠️ 检测到重复消息，已跳过 message_id:", messageId);
      return;
    }

    const content = JSON.parse(event.message.content);
    const userText = content.text.replace(/@\S+/g, "").trim();
    const chatId = event.message.chat_id;
    console.log("chat_id:", chatId, "userText:", userText);

    // 手动触发待发货检查（必须放在查货号正则之前，否则"查待发货"会被当成关键词搜索拦截）
    if (userText === "查待发货") {
      await sendLarkMessage(chatId, "⏳ 正在查询待发货订单...");
      await listAllPendingShipments(chatId);
      return;
    }

    // 诊断：查某个订单的真实状态，例如「查订单 5122277424755007608」
    const orderMatch = userText.match(/^查订单\s*(\d+)/);
    if (orderMatch) {
      try {
        const detail = await getOrderDetail(orderMatch[1]);
        const statusText = ORDER_STATUS_TEXT[detail.order_status] || `未知(${detail.order_status})`;
        await sendLarkMessage(chatId,
          `📦 订单 ${detail.order_no}\n状态: ${statusText} (${detail.order_status})\n商品: ${detail.goods?.title || "未知"}\n支付时间: ${detail.pay_time ? new Date(detail.pay_time * 1000).toLocaleString("zh-CN") : "无"}\n取消时间: ${detail.cancel_time || "无"}\n退款状态: ${detail.refund_status}`
        );
      } catch (err) {
        await sendLarkMessage(chatId, `❌ 查询失败: ${err.message}`);
      }
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
    console.error("处理消息出错:", err);
  }
}

// ── 健康检查（给 Railway 探活用，飞书消息不再走这条路） ──
app.get("/", (req, res) => res.send("ok"));

// ── 飞书长连接：服务器主动连出去拿事件，不再需要公网可被飞书访问的请求地址 ──
const eventDispatcher = new EventDispatcher({}).register({
  "im.message.receive_v1": async (data) => {
    await handleTextMessage(data);
  },
});

const wsClient = new WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
});

wsClient.start({ eventDispatcher }).then(() => {
  console.log("🔌 飞书长连接已建立");
}).catch((err) => {
  console.error("🔴 飞书长连接启动失败:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("🔴 未处理的 Promise 异常 (unhandledRejection):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🔴 未捕获的异常 (uncaughtException):", err);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
[admin@iZuf6g21iu5p7voctgwj3eZ fs-c-bot]$ 
