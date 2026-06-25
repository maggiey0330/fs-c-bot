import axios from "axios";

let tokenCache = { token: null, expiry: 0 };

export async function getTenantToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiry) {
    return tokenCache.token;
  }
  const res = await axios.post(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }
  );
  tokenCache = {
    token: res.data.tenant_access_token,
    expiry: Date.now() + (res.data.expire - 60) * 1000,
  };
  return tokenCache.token;
}

export async function sendMessage(receiveId, text, receiveIdType = "chat_id") {
  const token = await getTenantToken();
  await axios.post(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      receive_id: receiveId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

export async function updateBitableRecord(appToken, tableId, recordId, fields) {
  const token = await getTenantToken();
  await axios.patch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    { fields },
    { headers: { Authorization: `Bearer ${token}` } }
  );
}
