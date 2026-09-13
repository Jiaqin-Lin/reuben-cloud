/**
 * P9 · 地图金标准：**真解析（tree-sitter WASM）→ 真算边 → PageRank → 渲染**的逐字节比对。
 *
 * 【为什么在单测里放一条用真 WASM 的用例】其他 P9 用例都把符号与边当输入数据，于是
 * "真解析出来的签名长什么样"这件事从来没进过地图——而 P8 的签名重建（多行压一行、截到 200 字符、
 * 去掉行尾的 `{`）恰好是能让排版崩掉的一环。这里用 P8 的九语言 fixture 跑完整条链，
 * 把渲染结果逐字节钉住：换语言、换顺序、换缩进都会红。
 *
 * 【它不替代什么】真 PG 上的缓存与真 git 上的增量在集成测试里（`repo-index.integration.test.ts`
 * 的 P9 一节）；这条只回答"从源码到地图文本，字节是不是确定的"。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverFiles, parseBatch } from "../../src/index/parse.ts";
import { computeEdges } from "../../src/index/refs.ts";
import { buildRepoMap } from "../../src/index/repo-map.ts";
import { memoryRepoIndexStore, memoryRepoMapStore, seedRepoIndex } from "../index-fakes.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/index/", import.meta.url));
const REPO = "owner/golden";
const SHA = "f1xture5";

/** 期望的地图文本（改动渲染格式时**必须**一起改这里，并想清楚为什么）。 */
const EXPECTED = [
  "sample.ts:",
  "  export interface RouteContext",
  "  export type Handler = (ctx: RouteContext) => Promise<string>",
  "  export class Router",
  "  constructor(prefix: string)",
  "  add(path: string, handler: Handler): void",
  "  async dispatch(ctx: RouteContext): Promise<string>",
  "  export function createRouter(prefix: string): Router",
  "  export const defaultRouter = createRouter(\"/\")",
  "",
  "sample.rs:",
  "  pub struct Store",
  "  pub fn new(name: &str) -> Self",
  "  pub const MAX_RETRIES: u32 = 3",
  "  pub enum Mode",
  "  pub trait Reader",
  "  fn read(&self, key: &str) -> String",
  "  pub fn read(&self, key: &str) -> String",
  "  pub fn open(name: &str) -> Store",
  "",
  "sample.py:",
  "  class Session",
  "  MAX_RETRIES = 3",
  "  def refresh(self, ttl: int) -> str",
  "  def load_session(token: str) -> Session",
  "",
  "sample.rb:",
  "  class Session",
  "  MAX_RETRIES = 3",
  "  module Auth",
  "  def initialize(token)",
  "  def refresh(ttl)",
  "  def self.build(token)",
  "  def load_session(token)",
  "",
  "sample.java:",
  "  public class Store",
  "  public Store(String name)",
  "  public String read(String key, List<String> extra)",
  "  interface Reader",
  "  String read(String key)",
  "  enum Mode",
  "",
  "sample.js:",
  "  const format = (value) => `${value}`",
  "  const path = require(\"node:path\")",
  "  export function greet(name)",
  "  export class Greeter",
  "  constructor(prefix)",
  "  greet(name)",
  "  export const VERSION = \"1.0.0\"",
  "  export default function main()",
  "",
  "sample.go:",
  "  type Store struct",
  "  const MaxRetries = 3",
  "  type Reader interface",
  "  type Key string",
  "  func NewStore(name string) *Store",
  "  func (s *Store) Read(key string) (string, error)",
  "  func (s *Store) Close() error",
  "",
  "sample.php:",
  "  class Store implements Reader",
  "  const MAX_RETRIES = 3",
  "  interface Reader",
  "  public function read(string $key): string",
  "  public function __construct(string $name)",
  "  public function read(string $key): string",
  "  function open(string $name): Store",
  "",
  "sample.tsx:",
  "  export interface PanelProps",
  "  export function Panel({ title, count = 1 }: PanelProps)",
  "  export class PanelView extends Component<PanelProps>",
  "  render()",
].join("\n");

test("金标准：九语言 fixture 从真解析到地图文本，逐字节相同且两次一致", async () => {
  const discovery = await discoverFiles(FIXTURES);
  const outcome = await parseBatch({ root: FIXTURES, files: discovery.indexable });
  assert.equal(outcome.crashed, false);
  const parsed = outcome.files.filter((file) => file.status === "ok");
  assert.equal(parsed.length, 9, "九种语言都要解析成功");

  const edges = computeEdges({
    files: discovery.indexable.map((file) => file.path),
    symbols: parsed.map((file) => ({ path: file.path, symbols: file.symbols })),
    candidates: parsed.map((file) => ({ path: file.path, refs: { identifiers: file.identifiers, imports: file.imports } })),
  });

  const store = memoryRepoIndexStore();
  await seedRepoIndex(store, {
    repoKey: REPO,
    commitSha: SHA,
    symbols: parsed.flatMap((file) =>
      file.symbols.map((symbol) => ({ ...symbol, path: file.path, lang: file.lang, endLine: symbol.endLine })),
    ),
    edges,
    fileRefs: parsed.flatMap((file) => [
      ...file.identifiers.map((symbol) => ({ path: file.path, symbol, kind: "identifier" as const })),
      ...file.imports.map((symbol) => ({ path: file.path, symbol, kind: "import" as const })),
    ]),
    languages: discovery.byLanguage,
    files: discovery.all.length,
  });

  const options = { repoKey: REPO, commitSha: SHA, task: "修 Router 的 prefix", index: store, files: discovery.all };
  const first = await buildRepoMap({ ...options, maps: memoryRepoMapStore() });
  const second = await buildRepoMap({ ...options, maps: memoryRepoMapStore(), refresh: true });

  assert.equal(first.degraded, null);
  assert.equal(first.text, EXPECTED);
  assert.equal(second.text, first.text, "同样的输入两次出同一份字节");
  assert.equal(first.tokens, Math.ceil(first.body.length / 4));
  assert.ok(first.tokens <= 1500);
});
