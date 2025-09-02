// test_once.mjs — 使用 Node20 原生 fetch 测试非流式响应
// 运行：node test_once.mjs

const endpoint = 'http://127.0.0.1:8033/v1/chat/completions';

const payload = {
  model: 'gemini-webui',
  messages: [
    { role: 'user', content: '自检：请输出 OK（非流式测试）' }
  ],
  stream: false   // 非流式
};

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

if (!res.ok) {
  console.error('HTTP error:', res.status, res.statusText);
  process.exit(1);
}

const data = await res.json();
console.log(JSON.stringify(data, null, 2));
