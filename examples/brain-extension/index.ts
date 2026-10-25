// AsterHive 主脑自定义工具扩展示例：asterhive_example_note
//
// 这是什么：一个最小可用的 Pi 扩展（约 70 行），给内置主脑注册一个自定义工具
// asterhive_example_note——把一条笔记追加写入数据卷的 brain-notes.jsonl 并回确认。
//
// 签名依据（以 @earendil-works/pi-coding-agent 1.4.0 类型定义为准，勿凭记忆）：
//   - 扩展工厂：export default (pi: ExtensionAPI) => void | Promise<void>
//     （dist/core/extensions/types.d.ts `ExtensionFactory`；加载器 jiti.import 路径时取
//     default 导出且必须是函数，见 dist/core/extensions/loader.js loadExtensionModule）；
//   - 目录即扩展路径：目录下有 index.ts / index.js（或带 pi 字段的 package.json）即被加载，
//     Pi 解析 additionalExtensionPaths 时目录按此规则解析（loader.js resolveExtensionEntries）；
//   - 注册工具：pi.registerTool(tool: ToolDefinition)（types.d.ts），ToolDefinition.execute
//     签名 (toolCallId, params, signal, onUpdate, ctx) => Promise<AgentToolResult>；
//     AgentToolResult = { content: [{ type: 'text', text }], details }（@earendil-works/pi-agent-core
//     dist/types.d.ts）；
//   - 可导入的模块：jiti 别名表覆盖 'typebox' 与 '@earendil-works/pi-coding-agent'
//     （loader.js getAliases），node: 内置模块原生可用；其余 npm 依赖需要在扩展目录自备。
//
// 安全姿态（示范"主脑只分派不执行"的边界）：本扩展只允许写一个固定文件
//   <dataDir>/brain-notes.jsonl，没有 shell、没有任意路径读写。自定义工具是显式授权：
//   放进 extensions/ 的每个扩展都会随主脑会话加载，请勿注册 shell/文件系统通通道类工具。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

// 数据卷根目录：扩展运行在 AsterHive 服务器进程内，dataDir 经环境变量 ASTERHIVE_DATA 传入
// （容器部署 compose.yaml 固定 /data；开发部署见 apps/server/src/main.ts 的同款解析）。
// 不做静默兜底路径——拿不到就显式报错，避免把笔记写到错误位置。
function dataDir(): string {
  const dir = process.env.ASTERHIVE_DATA?.trim();
  if (!dir) throw new Error('环境变量 ASTERHIVE_DATA 未设置：扩展只能在 AsterHive 服务器进程内确定数据卷位置');
  return dir;
}

const NOTES_FILE = 'brain-notes.jsonl';
const MAX_TEXT_LENGTH = 20_000; // 单条笔记上限：防止失控输出撑爆文件

// 参数 schema 用 TypeBox（Pi ToolDefinition.parameters 要求 TypeBox）。
// 只暴露一个参数 { text }——schema 就是给模型看的工具契约，写清 description 比多给参数更有效。
const params = Type.Object({
  text: Type.String({ description: '要追加保存的一条笔记内容（纯文本，单条不超过 20000 字符）' }),
});

export default function exampleNoteExtension(pi: ExtensionAPI): void {
  const tool: ToolDefinition<typeof params> = {
    name: 'asterhive_example_note',
    label: 'asterhive_example_note',
    description:
      '把一条笔记追加写入星巢数据卷的 brain-notes.jsonl（JSONL，每行一条带时间戳的记录）。' +
      '用于跨会话留痕：主脑想把值得记住的判断/结论写下来时调用。本工具只写这一个文件，没有其他能力。',
    parameters: params,
    execute: async (_toolCallId, { text }) => {
      try {
        const value = text.trim();
        if (!value) throw new Error('笔记内容为空：text 必须是非空字符串');
        if (value.length > MAX_TEXT_LENGTH) throw new Error(`笔记过长（${value.length} > ${MAX_TEXT_LENGTH} 字符）`);
        const file = join(dataDir(), NOTES_FILE);
        mkdirSync(dataDir(), { recursive: true });
        const record = JSON.stringify({ ts: new Date().toISOString(), text: value });
        appendFileSync(file, `${record}\n`, 'utf8');
        // 成功结果：content 给模型看，details 供 UI/程序用（见 AgentToolResult 类型）
        return {
          content: [{ type: 'text', text: `已写入 ${NOTES_FILE}（${value.length} 字符）：${value.slice(0, 80)}${value.length > 80 ? '…' : ''}` }],
          details: { file },
        };
      } catch (err) {
        // 失败不抛异常：以 isError 结果回给模型，模型能读到原因并自行纠正/放弃
        return {
          content: [{ type: 'text', text: `asterhive_example_note 失败：${err instanceof Error ? err.message : String(err)}` }],
          details: {},
          isError: true,
        };
      }
    },
  };
  pi.registerTool(tool); // 注册即对模型声明（exposure 默认 'direct'）；主脑 noTools:'builtin' 不影响扩展工具
}
