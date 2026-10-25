# AsterHive Web 设计系统

> 适用范围：`apps/web/src/styles.css`（v2，2026-10-25 全量重写）。
> 静态预览与截图自查页：`tools/design-preview.html`（直接链源 CSS，不进构建产物）。

## ⚠️ 改样式前先读（两次返工的教训）

1. **不要手工发明暗色调色板。** 此前两版暗色主题（`#0b0d12 / #12151c / #181c26` 一族蓝灰）均被否决。
   本次起暗色体系**锁定 shadcn/ui dark 的 zinc 色阶换算令牌**（见下表），蜂蜜金 `--primary` 是全站唯一彩色主操作色。
   想加新颜色时：先问"它在 shadcn 令牌里对应谁"，对不上就不要加。
2. **边框一律白低透明**（`--border` / `--border-strong`），绝不用不透明灰；彩色边框类已全部退役（acceptance 左金条、token-once 金框等），不要复活。
3. **暗色下层级靠明度差**（`--background #09090b → --card #18181b → --popover #1c1c1f`），不靠阴影堆叠。
   阴影只有两档：`--shadow-sm`（日常可忽略）、`--shadow-lg`（仅抽屉/浮层/窄屏滑入 overlay）。
4. **结构性间距只用 4 / 8 / 16 / 24 / 32 / 48**。组件配方明确给出的小值（pill 内边距、field 的 6px、气泡 10px 圆角等）按配方来，不要"顺手调成 10px 舒服点"。
5. **布局三条硬纪律**（线上三 bug 的修复，回归时逐项对照）：
   - 按钮永不换行：基类 `white-space: nowrap; flex-shrink: 0;`。空间不够时让父容器换行（`flex-wrap: wrap`），不允许单个按钮内折行。
   - 表单字段永不互相挤压：`.grid-form` 用 `repeat(auto-fit, minmax(240px, 1fr))` 自适应降列；`.field` 自身 `min-width: 0` 的纵向 flex。
   - 气泡排版：`.msg` 顶部对齐 + 头像 `flex-shrink: 0`；气泡体 `min-width: 0; max-width: 82%` 作用在内容盒上（配合 `overflow-wrap: anywhere`）；`.msg.me` 无头像纯右对齐（与 `views/room.ts` 的 DOM 一致）；气泡内部 meta 与正文纵向 flex（gap 4）。
6. 改完样式必须跑自查：`tools/design-preview.html` 截图（1280 / 1600 两档宽 + 窄容器压力区）+ `npm run typecheck` + `npm test` + `vite build`。

## 设计令牌表

### 中性面（shadcn dark × zinc）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--background` | `#09090b` | 页面底；导航/聊天舞台/看板栏与其同底 |
| `--foreground` | `#fafafa` | 一级文字 |
| `--card` | `#18181b` | 面板/卡片/气泡/composer 底 |
| `--card-foreground` | `#fafafa` | 卡片内文字 |
| `--popover` | `#1c1c1f` | 浮层/抽屉/toast 底 |
| `--secondary` | `#27272a` | 次级表面：默认按钮底、头像、徽标灰底、acceptance |
| `--secondary-foreground` | `#fafafa` | 次级表面上的文字 |
| `--muted` | `#27272a` | muted 面底（与 secondary 同值，语义别名） |
| `--muted-foreground` | `#a1a1aa` | 二级文字（zinc-400） |
| `--subtle-foreground` | `#71717a` | 三级文字（zinc-500）：占位符/时间戳/表头/lane 名 |
| `--accent` | `rgba(255,255,255,0.06)` | ghost/选中态 hover 面 |
| `--dot-idle` | `#52525b` | 离线/停用状态点、P2 圆点（zinc-600，不作文字色） |

### 品牌（唯一彩色主操作）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--primary` | `#e8a33d` | 蜂蜜金：主按钮、发送键、P1 圆点、active 导航图标、avatar 主脑点 |
| `--primary-foreground` | `#18181b` | 金底上的文字 |
| `--primary-hover` | `#f0b45a` | 主按钮 hover |
| `--mention` | `#f4b95c` | @mention 文字、orchestrator 角色徽标文字 |

### 边框 / 输入 / 焦点

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--border` | `rgba(255,255,255,0.10)` | 所有常规边框 |
| `--border-strong` | `rgba(255,255,255,0.16)` | 输入控件边框、composer 边框、hover 提亮 |
| `--input-bg` | `rgba(255,255,255,0.045)` | 输入控件底（白 4.5% 微提亮） |
| `--ring` | `rgba(255,255,255,0.14)` | 焦点外圈（3px） |
| `--destructive` | `#dc2626` | 危险按钮底（55%/75% 透明度使用） |

### 语义色（暗色用 400 档）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--ok` | `#4ade80` | 成功、在线、res-ok |
| `--warn` | `#facc15` | 警告、忙碌/断线候选状态、stale 聚合 |
| `--danger` | `#f87171` | 失败文字、P0、WIP 满、连接中断、删除确认 |
| `--info` | `#60a5fa` | worker 角色、taskRef 链接、avatar worker 点 |

### 字号 / 行高 / 圆角 / 阴影 / 滚动条

- 基准字号 **14px**、行高 1.5；标题 **16px**、行高 1.2；小字 13 / 12 / 11px。
- 圆角：`--radius-lg: 12px`（面板/抽屉/舞台）、`--radius: 8px`（控件/卡片）、`--radius-sm: 6px`（小元素）；气泡与 composer 用 10px（配方特例）；pill 用 999px。
- 阴影：`--shadow-sm: 0 1px 2px rgba(0,0,0,.35)`；`--shadow-lg: 0 16px 48px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4)`（仅抽屉/浮层/overlay）。
- 滚动条：8px，thumb `#303036`（hover `#3f3f46`）圆角，track 透明。
- 间距刻度：4 / 8 / 16 / 24 / 32 / 48。

## 组件配方摘要

### 按钮（inline-flex 居中、gap 8、radius 8、font 500、14px、过渡 .15s、nowrap + shrink-0）

| 变体 | 底 | 字 | 高/内边距 | hover |
| --- | --- | --- | --- | --- |
| 默认（secondary） | `--secondary` | `--foreground` | 36 / 0 16 | 白 10% 覆盖层提亮（不换底色） |
| `.primary` | `--primary` | `--primary-foreground` | 36 / 0 16 | `--primary-hover` |
| `.ghost` | 透明 | `--muted-foreground` | 32 / 0 12 | `--accent` 面 + `--foreground` 字 |
| `.danger` | `rgba(220,38,38,.55)` | `#fff` | 36 / 0 16 | `rgba(220,38,38,.75)` |
| `.sm` / 面板·抽屉内 | 继承变体 | 13px | 28 / 0 10 | — |
| `.icon-btn` | 透明方块 28×28 | `--muted-foreground` | — | `--accent` 面 |

焦点（全部按钮，仅 `:focus-visible`）：`outline: none; border-color: var(--border-strong); box-shadow: 0 0 0 3px var(--ring)`；禁用 `opacity .5`（发送键 `.4`）。

### 输入类（input/select/textarea）

h 36（面板/抽屉内 32、页头切板下拉 28）、px 12、radius 8、底 `--input-bg`、边框 `--border-strong`、字 `--foreground`、占位符 `--subtle-foreground`；`:focus-visible` 边框 `rgba(255,255,255,.3)` + ring 3px；select 用内联 SVG 箭头（stroke `#a1a1aa`）；textarea 行高 1.5、padding 8 12。

### pill 配方（仓库链接 / 计数胶囊 / 徽标 / 聚合条）

h 22、px 8、radius 999、border `--border`、字 12px `--muted-foreground`、hover 边框提亮；WIP 满 `.count.full` 红字；徽标类（badge / kind-badge / lane-badge / role-badge / dep）同族：`--secondary` 底或透明底 + 999 圆角 + 10.5–12px 字。

### 导航

宽 200、与页面同底、右边框 `--border`；品牌行 16px/600 金色六边形 + 前景字；nav-item h 34 / radius 8 / px 12 / 14px `--muted-foreground`，hover 提字，**active = `--accent` 面 + 前景字 + 图标金色**；项目子项 12.5px + 5px 前缀圆点（当前实心金、其余空心）；底部在线行 12px 三级字 + 6px 绿点。

### 泳道与紧凑卡

lane 名 12px 三级字（字距 0.02em）+ 计数 pill；紧凑卡 `--card` 底、`--border` 边、radius 8、padding 10 12、宽 176 / 最小高 84；首行 6px 优先级圆点（P0 红 / P1 金 / P2 灰）+ 任务号 11px 三级字（等宽 + tabular-nums）+ @负责人 11px 二级灰右浮；标题 13px 前景两行截断；hover 边框 `rgba(255,255,255,.22)`。

### 聊天气泡与 composer

- 消息行 `display:flex; gap:10px; align-items:flex-start`，头像 28px（radius 8、`--secondary` 底、右下 6px 角色点：主脑金 / worker 蓝 / system 灰）。
- 气泡 `--card` 底、radius 10（左下 3）、max-width 82%、padding 8 12、正文 14px；内部 meta（名字 12px/600 二级灰 + kind pill 10.5px + 时间 11px 三级）与正文纵向 flex、gap 4，meta 可换行。
- `.msg.me`：右对齐、无头像、底 `rgba(232,163,61,.13)`、边 `rgba(232,163,61,.28)`、radius 10（右下 3）。
- @mention `--mention` 500；taskRef `--info` 点式下划线。
- composer 整行 `--card` 卡（border-strong、radius 10、padding 6 6 6 12），focus-within 边框提亮 + ring；目标 select 透明无边框 h 28；textarea 透明 1–3 行自适应；发送键 30px 方形金底 radius 7。

### 表格 / 抽屉 / toast

- 表头 12px 三级字、padding 10 12、下边框 `--border`；行 padding 10 12、下边框白 6%、hover `--accent`；数字列 tabular-nums（td 全局启用）。
- 抽屉 `--popover` 底、border-left、shadow-lg、宽 440；遮罩 `rgba(0,0,0,.5)` + backdrop-blur 2px；field label 12px 三级字、控件间距 16（field 内 label-控件 gap 6）。
- toast 右下浮层：`--popover` 底、border-strong、shadow-lg、radius 10、padding 12 16。

### 状态点映射（8px）

| 状态 | 颜色 |
| --- | --- |
| working（忙碌）/ stale（断线候选） | `--warn` |
| idle / on（在线） | `--ok` |
| disabled / off（离线侧） | `--dot-idle`（#52525b） |
| 连接中断（conn.off） | `--danger`（属错误态） |

角色徽标：orchestrator → `--mention`、worker → `--info`、user → `--muted-foreground`（灰底 pill）。

## 自查流程

1. `npm run typecheck` 全绿；`npm test` 62/62；`cd apps/web && npx vite build` 成功。
2. `grep -rE "#0b0d12|#12151c|#171b24|#181c26|#252b38|#8a93a8|#dfe4ee|#5c6478" apps/web/src` 必须零命中（旧调色板清零）。
3. 打开 `tools/design-preview.html` 无头截图：1280px 与 1600px 各一张（工作台横截面 + 组件陈列区），另截 260px 窄容器压力区——确认无按钮内换行、无输入框互压、气泡左右对齐正确。
