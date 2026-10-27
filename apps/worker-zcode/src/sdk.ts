// 本地工作区桥接：以相对路径导出 packages/sdk，
// 避免 Node 24 --experimental-strip-types 加载 node_modules 下未构建 TS 文件触发
// ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING 运行时硬限制。
export * from '../../../packages/sdk/src/index.ts';
