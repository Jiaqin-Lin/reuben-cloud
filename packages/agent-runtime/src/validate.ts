/**
 * `validate.ts` —— 工具参数校验（TypeBox，设计文档 §B.3 的"一份声明三个用途"）。
 *
 * 【为什么要有这一步】工具参数来自模型，不可信：少字段、类型错、多塞一个键都可能。
 * 校验失败必须变成**模型能看懂的结果**（"缺 path"比"TypeError: Cannot read properties
 * of undefined"可行动一个数量级）。M0 是手写 JSON Schema + 手写校验，两处会漂；
 * 这里用 TypeBox 的编译校验器，schema 就是发给模型的那一个。
 *
 * 【为什么要 Convert】provider 会用字符串/数字混着发（`"limit": "50"`）。TypeBox 的
 * `Value.Convert` 按 schema 做无损转换，把 `"50"` 变成 `50`——这比让模型因为一个引号
 * 重发一次便宜得多。**只在类型明确时转**（`Convert` 的语义），不会把 `"abc"` 变成 0。
 *
 * 【可选字段的 null】有些 provider 会用 `null` 表示"没给"。先在 schema 允许的位置把它们
 * 删掉，再校验——否则每个可选字段都要在 schema 里写 `| null`，而那会让发给模型的
 * JSON Schema 变脏。
 */

import { Compile } from "typebox/compile";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AgentTool, ToolCallContent } from "./types.ts";

/** 编译过的校验器（按 schema 对象缓存：同一个工具 schema 只编译一次）。 */
const validators = new WeakMap<object, ReturnType<typeof Compile>>();

function validatorFor(schema: TSchema): ReturnType<typeof Compile> {
  const cached = validators.get(schema);
  if (cached !== undefined) return cached;
  const compiled = Compile(schema);
  validators.set(schema, compiled);
  return compiled;
}

/**
 * 校验一次工具调用的参数。
 *
 * @returns 校验（必要时转换）过的参数。**可能是同一个对象的浅层拷贝**，调用方可以直接用。
 * @throws Error 校验失败，message 里带**逐字段的错**与模型发来的原文（模型据此自己改）。
 */
export function validateToolArguments<TParams extends TSchema>(
  tool: AgentTool<TParams>,
  call: ToolCallContent,
): Record<string, unknown> {
  const args = cloneArguments(call.arguments);
  dropOptionalNulls(args, tool.parameters as Record<string, unknown>);
  Value.Convert(tool.parameters, args);
  const validator = validatorFor(tool.parameters);
  if (validator.Check(args)) return args;

  const errors = validator
    .Errors(args)
    .map((error) => `  - ${error.instancePath === "" ? "/" : error.instancePath}: ${error.message}`)
    .join("\n");
  throw new Error(
    `工具 "${call.name}" 的参数不合法：\n${errors}\n\n模型发来的参数：\n${JSON.stringify(call.arguments, null, 2)}`,
  );
}

/** 浅拷贝一层（校验器会就地改，不能污染调用方手里的原始 arguments）。 */
function cloneArguments(args: Record<string, unknown>): Record<string, unknown> {
  return { ...args };
}

/**
 * 把"可选字段的 null"删掉。只处理对象**第一层**——我们所有工具的 schema 都是
 * "顶层对象 + 标量字段"，嵌套的 null 校验会照常报错（那才是对的：嵌套结构不该猜）。
 */
function dropOptionalNulls(args: Record<string, unknown>, schema: Record<string, unknown>): void {
  const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  for (const key of Object.keys(args)) {
    if (args[key] !== null) continue;
    if (required.includes(key)) continue;
    if (properties[key] === undefined) continue;
    delete args[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
