// test_stream.mjs — 使用 Node20 原生 fetch 读取 SSE（/v1/chat/completions）
// 运行：node test_stream.mjs

const endpoint = 'http://127.0.0.1:8033/v1/chat/completions';

const payload = {
  model: 'gemini-webui',
  messages: [
    // { role: 'user', content: '写一首夏天的诗' }
      { role: 'user', content: '写一首春天的诗' }
  ],
  stream: true
};

const res = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});

if (!res.ok || !res.body) {
  console.error('HTTP error:', res.status, res.statusText);
  process.exit(1);
}

// 将二进制流按行解析，提取 "data: {...}" / "data: [DONE]"
const reader = res.body.getReader();
const decoder = new TextDecoder('utf-8');

let buffer = '';
let fullText = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });

  // 拆分行（SSE 以 \n 分隔，一条消息通常以空行结尾）
  let lines = buffer.split(/\r?\n/);
  // 最后一段可能是不完整行，先留在 buffer 里
  buffer = lines.pop() ?? '';

  for (const line of lines) {
    if (!line.startsWith('data:')) continue;

    const payload = line.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      console.log('\n[SSE] DONE');
      break;
    }

    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta?.content ?? '';
      if (delta) {
        fullText += delta;
        process.stdout.write(delta);
      }
    } catch {
      // 有些实现可能会发心跳/非 JSON 数据，直接忽略
    }
  }
}

console.log('\n--- done ---');
