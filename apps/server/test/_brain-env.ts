// t-brain 专用环境：必须在 src/brain.ts 模块求值前设置（brain.ts 在模块顶层读环境变量）。
// ESM 按声明顺序求值依赖模块，t-brain.test.ts 把本文件放在第一条 import 即可保证生效。
process.env.ASTERHIVE_BRAIN_DEBOUNCE_MS = process.env.ASTERHIVE_BRAIN_DEBOUNCE_MS ?? '200';
process.env.ASTERHIVE_BRAIN_TURN_TIMEOUT_MS = process.env.ASTERHIVE_BRAIN_TURN_TIMEOUT_MS ?? '60000';
export {};
