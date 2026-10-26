// 内联 SVG 线性图标集：16px 视窗 / stroke 1.5 / currentColor，手写 path，不引图标库。
// 统一挂 class="i" 便于 CSS 控制尺寸与对齐；颜色随父级 color 变化（角色色只做文字与小点）。
const svg = (body: string): string =>
  `<svg class="i" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const icon = {
  /** 对话框（聊天） */
  chat: svg(
    '<path d="M2 3.8a1.3 1.3 0 0 1 1.3-1.3h9.4A1.3 1.3 0 0 1 14 3.8v5.9a1.3 1.3 0 0 1-1.3 1.3H8.2L5 13.6v-2.6H3.3A1.3 1.3 0 0 1 2 9.7z"/>',
  ),
  /** 文件夹（项目/看板） */
  folder: svg(
    '<path d="M1.8 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h5.7a1 1 0 0 1 1 1v5.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z"/>',
  ),
  /** 蜂巢六边形（品牌 / Agent 总览） */
  hive: svg(
    '<path d="M8 1.6l5.4 3.1v6.6L8 14.4l-5.4-3.1V4.7z"/><path d="M8 5.1l2.7 1.6v3L8 11.3 5.3 9.7v-3z"/>',
  ),
  /** 插头（Agent 接入） */
  plug: svg(
    '<path d="M5.6 1.8V5M10.4 1.8V5"/><path d="M3.8 5h8.4v2.2a4.2 4.2 0 0 1-8.4 0z"/><path d="M8 11.4v2.8"/>',
  ),
  /** 齿轮（设置 / 管理） */
  gear: svg(
    '<circle cx="8" cy="8" r="2.4"/><path d="M8 1.6v2.2M8 12.2v2.2M1.6 8h2.2M12.2 8h2.2M3.5 3.5L5 5M11 11l1.5 1.5M12.5 3.5L11 5M5 11l-1.5 1.5"/>',
  ),
  /** 列表（审计） */
  list: svg(
    '<path d="M5.6 4h8.6M5.6 8h8.6M5.6 12h8.6"/><circle cx="2.4" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.4" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.4" cy="12" r="1" fill="currentColor" stroke="none"/>',
  ),
  /** 链接（仓库地址） */
  link: svg(
    '<path d="M10 4.7h2a3.3 3.3 0 0 1 0 6.6h-2"/><path d="M6 11.3H4a3.3 3.3 0 0 1 0-6.6h2"/><path d="M5.4 8h5.2"/>',
  ),
  /** 加号（建卡 / 新项目） */
  plus: svg('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  /** 关闭（抽屉） */
  x: svg('<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'),
  /** 右向箭头（面板折叠按钮） */
  chevron: svg('<path d="M6 3.4L10.6 8 6 12.6"/>'),
  /** 纸飞机（发送） */
  send: svg('<path d="M14.2 1.8L7.4 8.6M14.2 1.8L9.8 14.2 7.4 8.6 2 6.2z"/>'),
  /** 方块（停止蜂后当前轮次：蜂后活跃期间发送按钮切换为停止按钮） */
  stop: svg('<rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.4"/>'),
  /** 时钟（耗时 / 心跳） */
  clock: svg('<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.4 1.4"/>'),
  /** 对勾（累计完成） */
  check: svg('<path d="M3 8.6l3.2 3.2L13 5.2"/>'),
};
