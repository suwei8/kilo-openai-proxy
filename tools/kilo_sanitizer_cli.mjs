#!/usr/bin/env node
// tools/kilo_sanitizer_cli.mjs
// 交互式 CLI：读取请求体 JSON，按指定规则精简，并打印结果与统计

// ## 正确用法（Ask 模式）

// 前提：输入 JSON 里已经包含 `Current Mode\n<slug>ask</slug>`。
// 命令示例（推荐参数）：

// ```bash
//     node tools\kilo_sanitizer_cli.mjs json\ask.json --mode tools-minimal --no-env --strip-stream-options --strip-model
// ```

// 说明：

// * `--mode=tools-minimal`：启用“极简工具协议”精简；
// * `--no-env`：去掉 `<environment_details>`；
// * `--strip-stream-options`：去掉 `stream_options`；
// * `--strip-model`：去掉顶层 `model` 字段（你也可以不写，如果已设为默认移除）。

// > 你不需要再写 `--keep=...`，Ask 的工具白名单会**自动按请求体中的 `<slug>ask</slug>` 识别**并注入到极简 system 提示里。

// ## 如果你的输入文件不是 ask（但你想当作 ask 处理）

// 当前版本是**按请求体自动识别**模式；最快方法是把输入 JSON 里的模式标签改成：

// ```
// Current Mode
// <slug>ask</slug>
// ```

// 然后用上面的命令跑即可。

// （如果你想要“命令行里强制 ask，不改文件”，我可以再给你加一个 `--force-slug=ask` 的小开关，随用随走。）




import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERSION,
  MODE_PRESETS,
  sanitizeFile,
} from './kilo_sanitizer.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgv(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = i + 1 < argv.length ? argv[i + 1] : undefined;
    const takeVal = (k) => { args[k] = next; i++; };

    if (!a.startsWith('-')) { args._.push(a); continue; }

    switch (a) {
      case '--mode': takeVal('mode'); break; // tools-minimal | tools-off | passthrough
      case '--keep': takeVal('keep'); break; // comma list
      case '--no-env': args.stripEnv = true; break; // 语义：启用剥离 env（默认 true）
      case '--keep-env': args.stripEnv = false; break;
      case '--strip-stream-options': args.stripStreamOptions = true; break;
      case '--strip-model': args.stripModel = true; break; // 无条件移除 model
      case '--block-models': takeVal('blockModels'); break; // 逗号分隔阻断列表（含 * 通配）
      case '--lang': takeVal('lang'); break; // zh | en
      case '--prune-top': args.stripUnknownTopFields = true; break;
      case '--no-pretty': args.pretty = false; break;
      case '--pretty': args.pretty = true; break;
      case '-o':
      case '--output': takeVal('output'); break;
      case '-q':
      case '--quiet': args.quiet = true; break;
      case '-v':
      case '--version': console.log(`kilo-sanitizer v${VERSION}`); process.exit(0);
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith('--')) {
          console.error(`未知参数: ${a}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp() {
  console.log(`\n用法: node tools/kilo_sanitizer_cli.mjs <input.json> [选项]\n\n选项：
  --mode <tools-minimal|tools-off|passthrough>  指定精简模式（默认 tools-minimal）
  --keep <a,b,c>                                额外保留的工具标签（逗号分隔）
  --no-env | --keep-env                         移除/保留 <environment_details>（默认移除）
  --strip-stream-options                        移除顶层 stream_options 字段
  --strip-model                                 无条件移除顶层 model 字段
  --block-models <m1,m2>                        仅当命中这些模型名时移除 model（支持 * 通配）。示例：--block-models gemini-2.5-flash,gemini-webui
  --lang <zh|en>                                极简系统提示语言（默认 zh）
  --prune-top                                   仅保留常见顶层字段（安全模式）
  --pretty | --no-pretty                        输出是否格式化（默认 pretty）
  -o, --output <file>                           输出到文件（默认打印到控制台）
  -q, --quiet                                   只打印统计信息，不打印 JSON 正文
  -v, --version                                 打印版本
  -h, --help                                    查看帮助\n\n示例：
  node tools/kilo_sanitizer_cli.mjs json/code.json --mode=tools-minimal --keep=read_file,apply_diff --block-models=gemini-2.5-flash --strip-stream-options\n`);
}

async function loadConfig(startDir) {
  // 支持本地配置 .kilo-sanitizer.json（可被 CLI 覆盖）
  const candidate = path.resolve(startDir || process.cwd(), '.kilo-sanitizer.json');
  try {
    const raw = await fs.readFile(candidate, 'utf8');
    const cfg = JSON.parse(raw);
    return cfg || {};
  } catch {
    return {};
  }
}

function mergeOptions(cfg, argv) {
  const out = { ...cfg };
  if (argv.mode) out.mode = argv.mode;
  if (argv.keep != null) out.keep = String(argv.keep).split(',').map(s => s.trim()).filter(Boolean);
  if (argv.stripEnv != null) out.stripEnv = !!argv.stripEnv; else if (out.stripEnv == null) out.stripEnv = true;
  if (argv.stripStreamOptions != null) out.stripStreamOptions = !!argv.stripStreamOptions;
  if (argv.stripModel != null) out.stripModel = !!argv.stripModel;
  if (argv.blockModels != null) out.blockModels = String(argv.blockModels).split(',').map(s => s.trim()).filter(Boolean);
  if (argv.lang) out.lang = argv.lang;
  if (argv.stripUnknownTopFields != null) out.stripUnknownTopFields = !!argv.stripUnknownTopFields;
  if (argv.pretty != null) out.pretty = !!argv.pretty; else if (out.pretty == null) out.pretty = true;
  return out;
}

function sizeStr(n) { return `${n}B`; }
function pct(saved, before) {
  if (!before) return '0.0%';
  return (saved / before * 100).toFixed(1) + '%';
}

(async function main() {
  const argv = parseArgv(process.argv);
  const input = argv._[0];
  if (!input) {
    printHelp();
    process.exit(2);
  }
  const cfg = await loadConfig(path.dirname(path.resolve(input)));
  const options = mergeOptions(cfg, argv);

  // 默认模式
  if (!options.mode) options.mode = 'tools-minimal';

  const { json, changed, reason, bytesBefore, bytesAfter } = await sanitizeFile(input, options);
  const saved = Math.max(0, bytesBefore - bytesAfter);

  console.log(`模式: ${options.mode}  改动: ${changed}  原因: ${reason}`);
  console.log(`体积: ${sizeStr(bytesBefore)}  ->  ${sizeStr(bytesAfter)}  (节省 ${sizeStr(saved)}, ${pct(saved, bytesBefore)})\n`);

  if (!argv.quiet) {
    const space = options.pretty ? 2 : 0;
    const text = JSON.stringify(json, null, space);
    if (argv.output) {
      await fs.writeFile(argv.output, text, 'utf8');
      console.log(`已写入: ${path.resolve(argv.output)}`);
    } else {
      console.log('=== 精简后的 JSON ===\n');
      console.log(text);
    }
  }
})().catch(err => {
  console.error('运行失败:', err?.stack || err?.message || err);
  process.exit(1);
});
