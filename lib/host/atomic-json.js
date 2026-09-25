/**
 * 原子 JSON 落盘 + 乐观并发（CAS）。
 *
 * 为什么不用 `ctx.storage`：那是官方存储服务的领地，第三方插件往里头塞
 * 自己的 schema 会污染它的命名空间（tavern 也是刻意避开、自建目录的）。
 * 书库是纯本地的用户资产，用一个可读、可迁移、可被别的工具消费的 JSON
 * 反而更合适。
 *
 * 为什么需要 CAS：同一个书库可能被两个浏览器标签页同时打开。没有
 * `revision` 校验的读-改-写会静默吞掉另一边的写入（丢进度、丢笔记）。
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 计算内容的 revision。
 *
 * @param {string} text 文件文本
 * @returns {string} `sha256:<hex>`
 */
export function revisionOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * 原子写一个 JSON 文件。
 *
 * 先写同目录的临时文件再 `rename`：`rename` 在同一卷上是原子的，
 * 因此读者永远看不到「写了一半」的 JSON。临时文件名带 pid 与随机数，
 * 避免两个进程/标签页撞名。
 *
 * @param {string} path 目标绝对路径
 * @param {unknown} value 可 JSON 序列化的值
 * @param {{ pretty?: boolean }} [options] pretty 默认 true（人要读这些文件）
 * @returns {{ revision: string, text: string }}
 */
export function atomicWriteJson(path, value, options = {}) {
  const { pretty = true } = options
  const text = pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value)
  atomicWriteText(path, text)
  return { revision: revisionOf(text), text }
}

/**
 * 原子写一个文本文件。
 *
 * @param {string} path 目标绝对路径
 * @param {string} text 文本内容
 */
export function atomicWriteText(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不应掩盖原始错误 */
    }
    throw error
  }
}

/**
 * 读一个 JSON 文件，缺失或损坏时回落到默认值。
 *
 * 损坏时**不抛错**：一个坏掉的 library.json 不应该让整个插件挂不上，
 * 那会让用户连导入入口都打不开。调用方拿 `recovered` 决定要不要提示。
 *
 * @param {string} path 绝对路径
 * @param {unknown} fallback 缺失/损坏时的返回值
 * @returns {{ value: unknown, revision: string|null, recovered: boolean }}
 */
export function readJson(path, fallback) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { value: fallback, revision: null, recovered: false }
  }
  try {
    return { value: JSON.parse(text), revision: revisionOf(text), recovered: false }
  } catch {
    return { value: fallback, revision: null, recovered: true }
  }
}

/**
 * 带 CAS 的读-改-写。
 *
 * `mutate` 拿到当前值，返回新值；若 `expectedRevision` 与磁盘上的实际
 * revision 不一致则抛 `REVISION_CONFLICT`，由调用方决定重试或报错。
 *
 * @param {string} path 绝对路径
 * @param {object} options
 * @param {unknown} options.fallback 文件缺失时的初始值
 * @param {(current: unknown, meta: { revision: string|null, recovered: boolean }) => unknown} options.mutate
 * @param {string|null} [options.expectedRevision] 调用方上次读到的 revision；null 表示要求文件不存在
 * @returns {{ value: unknown, revision: string }}
 */
export function updateJson(path, options) {
  const { fallback, mutate, expectedRevision } = options
  const current = readJson(path, fallback)
  if (expectedRevision !== undefined) {
    if (expectedRevision !== current.revision) {
      const error = new Error('REVISION_CONFLICT')
      error.code = 'REVISION_CONFLICT'
      error.expected = expectedRevision
      error.actual = current.revision
      throw error
    }
  }
  const next = mutate(current.value, { revision: current.revision, recovered: current.recovered })
  const written = atomicWriteJson(path, next)
  return { value: next, revision: written.revision }
}
