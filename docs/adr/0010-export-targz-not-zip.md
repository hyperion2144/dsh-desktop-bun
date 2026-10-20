# 0010 — 日志导出用 tar.gz 单包而非 zip

状态：Accepted（2026-10-20）

## 背景

统一日志管理（map #221）需要把用户选定时间范围内的日志打包导出。需求早期的默认设想是 zip（用户最熟悉的格式），但实现面受限：运行时是 Bun 1.4，其压缩面只有 `gzipSync`/`deflateSync` 一类单流压缩原语，没有 ZIP 容器写入器；自写 ZIP 容器（local file header + central directory + CRC32）等于手造归档格式，复杂度与出错面都不划算。

## 决策

导出产物为**单个 tar.gz 包**（`dsh-logs-YYYYMMDD-HHmmss.tar.gz`）：先组 tar 流（纯逻辑，仓内自实现 512 字节块格式），再 `gzipSync` 压缩落盘。包内按日志源分文件，附 `manifest.json` 写明时间范围、近似口径与各源份数。

## 取舍

- 用户拿到的是 `.tar.gz` 而非 `.zip`：macOS/Linux 双击即开；Windows 10 1809+ 资源管理器原生支持 tar.gz 解包，维护者（收日志的主要人群）全部熟 tar。放弃 zip 换来零自造容器格式。
- tar 流是仓内最小实现（ustar 头 + 512 对齐），只写不读；解包交给系统工具，不引入解析面。

## 后果

- 导出实现收敛为「选份/选行 → tar → gzip」三个纯函数步骤，全部可注入时钟与 gzip 做确定性单测。
- 若未来真需要 zip（例如面向终端用户的附件通道），另立决策引入依赖，不在日志链路里私造。
