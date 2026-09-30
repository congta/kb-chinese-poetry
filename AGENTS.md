# 数据记录规则

- 新增或拆分诗词记录时，`id` 必须使用标准 MongoDB ObjectId 生成规则：4 字节 Unix 时间戳、5 字节进程随机值和 3 字节递增计数器，最终保存为 24 位小写十六进制字符串。
- 使用 MongoDB 驱动或运行 `node scripts/generate-object-id.mjs` 生成 ID；不得用纯随机 12 字节、随机 24 位十六进制字符串或手工编造的值代替 ObjectId。
- 按规范生成的新 ObjectId 直接写入即可，无需在写入前后扫描全项目检查冲突；不得复用已删除记录的 ID。
