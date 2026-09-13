/**
 * `dom.ts` —— 一个**极小的 DOM 替身**，只为让 `public/app.js` 能在 `node --test` 里跑起来。
 *
 * 【它不是浏览器，也不假装是】这里实现的是 `app.js` 真用到的那一小撮东西：
 * `createElement` / `createTextNode` / `append` / `prepend` / `remove` / `textContent` /
 * `classList` / `dataset` / `firstChild` / `lastChild` / `childNodes`。它**不**做布局、
 * 不解析 CSS、不跑选择器。
 *
 * 【那它测什么】测三件在"只读浏览器"之外没法保证的事：
 *  ① 渲染路径**不抛异常**（一个未定义的函数、一个写错的属性名，都是整页白屏）；
 *  ② 事件 → DOM 的形状对（`tool_call` 建的工具块里真的挂着后到的 `exec_*` 与 `tool_result`；
 *     轮次按 `turn` 事件分组；终态卡片落在最后）；
 *  ③ 有界渲染真的在丢（输出超过 400 行时最老的块被丢掉，并留下"前面 N 行没显示"）。
 *
 * 【它测不了什么】观感（间距、颜色、换行）、真实的滚动行为、`EventSource` 的真重连。
 * 那些仍然需要人眼看一次页面——所以 spec 的 Phase 13 验收标准里"打开页面能看到"这一条
 * 保留了手工形式。
 *
 * 【为什么不用 jsdom / happy-dom】那会给一个"本机回环上的 400 行开发工具"引入一棵依赖树，
 * 而它要保护的东西只有上面三条。这里 120 行的手写替身是**可控的**代价——不过它必须诚实：
 * 它接受的就是我们用到的那一个子集，多写一行都会让"测试通过"的含义变模糊。
 */

/** 一个元素或文本节点。 */
export class FakeNode {
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  className = "";
  /** `dataset` 就是一个普通对象（`app.js` 只往里写，不读别的东西）。 */
  readonly dataset: Record<string, string> = {};
  /** 文本节点的正文；元素节点是 null。 */
  text: string | null = null;
  open = false;
  hidden = false;
  href = "";
  title = "";

  /** 事件监听（`app.js` 只用了 click）。 */
  #listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, handler: () => void): void {
    const current = this.#listeners.get(type) ?? [];
    current.push(handler);
    this.#listeners.set(type, current);
  }

  /** 测试用：派人一个事件（浏览器里是用户真的点了）。 */
  dispatch(type: string): void {
    for (const handler of this.#listeners.get(type) ?? []) handler();
  }

  constructor(tagName: string, text: string | null = null) {
    this.tagName = tagName.toUpperCase();
    this.text = text;
  }

  /** 文本节点的正文 + 所有后代的正文，拼起来（浏览器语义的子集）。 */
  get textContent(): string {
    if (this.text !== null) return this.text;
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this.text = null;
    if (value !== "") this.append(new FakeNode("#text", String(value)));
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeNode("#text", node) : node;
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }

  prepend(node: FakeNode): void {
    node.parentNode = this;
    this.childNodes.unshift(node);
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent === null) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  get classList(): { add(...names: string[]): void; remove(...names: string[]): void; toggle(name: string, force?: boolean): void; contains(name: string): boolean } {
    const self = this;
    const names = (): string[] => self.className.split(/\s+/).filter((name) => name !== "");
    return {
      add: (...added: string[]) => {
        const current = names();
        for (const name of added) if (!current.includes(name)) current.push(name);
        self.className = current.join(" ");
      },
      remove: (...removed: string[]) => {
        self.className = names().filter((name) => !removed.includes(name)).join(" ");
      },
      toggle: (name: string, force?: boolean) => {
        const has = names().includes(name);
        const next = force === undefined ? !has : force;
        if (next && !has) self.className = [...names(), name].join(" ");
        if (!next && has) self.className = names().filter((entry) => entry !== name).join(" ");
      },
      contains: (name: string) => names().includes(name),
    };
  }

  /** 后代里第一个满足条件的元素（测试断言用；`app.js` 不调它）。 */
  find(predicate: (node: FakeNode) => boolean): FakeNode | null {
    for (const child of this.childNodes) {
      if (predicate(child)) return child;
      const nested = child.find(predicate);
      if (nested !== null) return nested;
    }
    return null;
  }

  /** 后代里所有满足条件的元素。 */
  findAll(predicate: (node: FakeNode) => boolean): FakeNode[] {
    const found: FakeNode[] = [];
    for (const child of this.childNodes) {
      if (predicate(child)) found.push(child);
      found.push(...child.findAll(predicate));
    }
    return found;
  }

  /** 按 class 找。 */
  all(className: string): FakeNode[] {
    return this.findAll((node) => node.classList.contains(className));
  }

  /** 按 class 找第一个。 */
  one(className: string): FakeNode | null {
    return this.find((node) => node.classList.contains(className));
  }
}

/** 一个假的 `EventSource` 实例：测试拿它手动派发 `open` / `error` / `message`。 */
export class FakeEventSource {
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.closed = true;
  }
}

export interface FakeDom {
  document: FakeDocument;
  window: Record<string, unknown> & { location: { pathname: string } };
  sources: FakeEventSource[];
  /** 直接丢给 `vm.createContext()` 的那一组全局（`app.js` 引用的裸名字）。 */
  globals: Record<string, unknown>;
}

export interface FakeDocument extends FakeNode {
  title: string;
  documentElement: FakeNode;
  getElementById(id: string): FakeNode | null;
  createElement(tagName: string): FakeNode;
  createTextNode(text: string): FakeNode;
}

/** 一条 `fetch` 规则：url 里包含 `match` 就用它回答。 */
export interface FetchRule {
  match: string;
  status: number;
  body: unknown;
}

/**
 * 造一个假浏览器环境。`ids` 是要事先存在的元素 id（`index.html` 里那些）。
 * `pathname` 决定 `app.js` 从 URL 里读到的 run id；`fetches` 决定 `/info` 怎么回答。
 */
export function createDom(options: { ids: string[]; pathname: string; fetches?: FetchRule[] }): FakeDom {
  const root = new FakeNode("html") as FakeDocument;
  const byId = new Map<string, FakeNode>();
  const documentElement = new FakeNode("html");
  documentElement.dataset["theme"] = "light";
  documentElement.append(new FakeNode("body"));

  root.title = "";
  root.documentElement = documentElement;
  for (const id of options.ids) {
    const node = new FakeNode("div");
    byId.set(id, node);
    documentElement.append(node);
  }
  root.getElementById = (id: string) => byId.get(id) ?? null;
  root.createElement = (tagName: string) => new FakeNode(tagName);
  root.createTextNode = (text: string) => new FakeNode("#text", text);

  const sources: FakeEventSource[] = [];
  const fetches = options.fetches ?? [];
  const storage = new Map<string, string>();

  const window: FakeDom["window"] = {
    location: { pathname: options.pathname },
    innerHeight: 800,
    scrollY: 0,
    scrollTo: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
    },
    addEventListener: () => undefined,
  };

  /** `new EventSource(url)` 在 `app.js` 里拿到的是注册进 `sources` 的同一个对象。 */
  class EventSourceStub extends FakeEventSource {
    constructor(url: string) {
      super(url);
      sources.push(this);
    }
  }

  class IntersectionObserverStub {
    constructor(_callback: unknown) {}
    observe(): void {}
    disconnect(): void {}
  }

  const fetchImpl = async (url: unknown): Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> => {
    const rule = fetches.find((candidate) => String(url).includes(candidate.match));
    if (rule === undefined) return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
    return { status: rule.status, ok: rule.status < 400, json: async () => rule.body };
  };

  return {
    document: root,
    window,
    sources,
    globals: {
      document: root,
      window,
      EventSource: EventSourceStub,
      IntersectionObserver: IntersectionObserverStub,
      fetch: fetchImpl,
      setTimeout,
      clearTimeout,
      console,
    },
  };
}
