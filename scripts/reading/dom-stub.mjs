/**
 * A tiny DOM stub for reader surface tests.
 *
 * It implements exactly the subset of the DOM the reader uses (element tree,
 * `querySelector(All)`, attributes, dialog `showModal`/`close`, focus, layout
 * numbers, events and a recording `animate`). Tests can therefore drive the real
 * `createArticleReader` in Node without a browser or a DOM library.
 */

const PARENT = new WeakMap();

function parseSelectorList(selector) {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/).filter(Boolean));
}

function matchesSimple(element, simple) {
  let rest = simple;
  const attrs = [];
  let id = null;
  const classes = [];
  let notTag = null;

  const attrPattern = /\[([^\]]+)\]/g;
  let match;
  while ((match = attrPattern.exec(rest))) {
    attrs.push(match[1]);
    rest = rest.replace(match[0], "");
  }
  const notPattern = /:not\(([^)]+)\)/g;
  while ((match = notPattern.exec(rest))) {
    notTag = match[1].trim();
    rest = rest.replace(match[0], "");
  }
  const idPattern = /#([\w-]+)/g;
  while ((match = idPattern.exec(rest))) {
    id = match[1];
    rest = rest.replace(match[0], "");
  }
  const classPattern = /\.([\w-]+)/g;
  while ((match = classPattern.exec(rest))) {
    classes.push(match[1]);
    rest = rest.replace(match[0], "");
  }
  const tag = rest.trim();
  if (tag && tag !== "*" && element.tagName !== tag.toLowerCase()) return false;
  if (id && element.id !== id) return false;
  for (const className of classes) if (!element.classList.contains(className)) return false;
  for (const attr of attrs) {
    const equals = /^([\w-]+)="?([^"]*)"?$/.exec(attr.trim());
    if (equals) {
      if (element.getAttribute(equals[1]) !== equals[2]) return false;
      continue;
    }
    if (!element.hasAttribute(attr.trim())) return false;
  }
  if (notTag && matchesSimple(element, notTag)) return false;
  return true;
}

function matchesSelector(element, selector) {
  const groups = parseSelectorList(selector);
  return groups.some((chain) => {
    let current = element;
    let index = chain.length - 1;
    if (!matchesSimple(current, chain[index])) return false;
    index -= 1;
    while (index >= 0) {
      let ancestor = PARENT.get(current) ?? null;
      const wanted = chain[index];
      while (ancestor && !matchesSimple(ancestor, wanted)) ancestor = PARENT.get(ancestor) ?? null;
      if (!ancestor) return false;
      current = ancestor;
      index -= 1;
    }
    return true;
  });
}

class StubClassList {
  constructor(element) {
    this.element = element;
  }
  get tokens() {
    return (this.element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  contains(token) {
    return this.tokens.includes(token);
  }
  add(token) {
    const next = [...new Set([...this.tokens, token])];
    this.element.setAttribute("class", next.join(" "));
  }
  remove(token) {
    this.element.setAttribute("class", this.tokens.filter((entry) => entry !== token).join(" "));
  }
  toggle(token, force) {
    const has = this.contains(token);
    const next = force === undefined ? !has : Boolean(force);
    if (next === has) return next;
    if (next) this.add(token);
    else this.remove(token);
    return next;
  }
}

class StubStyle {
  constructor() {
    this.properties = new Map();
  }
  setProperty(name, value) {
    this.properties.set(name, String(value));
  }
  getPropertyValue(name) {
    return this.properties.get(name) ?? "";
  }
}

class StubAnimation {
  constructor(keyframes, options) {
    this.keyframes = keyframes;
    this.options = options;
    this.playState = "running";
    this.cancelled = false;
    let resolveFinished;
    this.finished = new Promise((resolve) => {
      resolveFinished = resolve;
    });
    this._resolve = resolveFinished;
  }
  cancel() {
    this.playState = "idle";
    this.cancelled = true;
    this._resolve?.();
  }
  finish() {
    this.playState = "finished";
    this._resolve?.();
  }
}

export class StubElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = String(tagName).toLowerCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.classList = new StubClassList(this);
    this.style = new StubStyle();
    this.dataset = {};
    this.listeners = new Map();
    this.hidden = false;
    this.isConnected = true;
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 400;
    this.offsetTop = 0;
    this.offsetParent = {};
    this.focused = false;
    this.animations = [];
    this.textContentValue = "";
  }

  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(value) {
    this.setAttribute("id", value);
  }
  /** Mirrors the real property: reflects into the attribute (so focus traps see it). */
  get tabIndex() {
    const value = this.getAttribute("tabindex");
    return value === null ? (this.tagName === "a" && this.hasAttribute("href") ? 0 : -1) : Number(value);
  }
  set tabIndex(value) {
    this.setAttribute("tabindex", String(value));
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(value) {
    this.setAttribute("class", value);
  }
  /** No layout, no smooth scrolling: the request is applied immediately. */
  scrollTo(options) {
    if (typeof options === "number") {
      this.scrollTop = options;
      return;
    }
    if (options && typeof options.top === "number") this.scrollTop = options.top;
  }
  scrollIntoView() {
    // No layout; nothing to do.
  }
  /**
   * Simple selectors only (the same subset `querySelector` supports). Interaction
   * pseudo-classes have no state here, so they answer false — which is also what a
   * browser reports for an element the pointer is not over.
   */
  matches(selector) {
    const first = String(selector).split(",")[0].trim();
    if (first.startsWith(":")) return false;
    return matchesSelector(this, first);
  }
  get children() {
    return this.childNodes.filter((node) => node instanceof StubElement);
  }
  get textContent() {
    if (this.childNodes.length === 0) return this.textContentValue;
    return this.childNodes.map((node) => node.textContent ?? "").join("");
  }
  set textContent(value) {
    this.childNodes = [];
    this.textContentValue = String(value);
  }
  get innerHTML() {
    return this.childNodes.map((node) => (node instanceof StubElement ? `<${node.tagName}>${node.innerHTML}</${node.tagName}>` : "")).join("");
  }
  get parentNode() {
    return PARENT.get(this) ?? null;
  }

  /**
   * Minimal layout: the stub has no renderer, so every box is laid out at the
   * scrolling position of its nearest scroll host. The navigation rail only needs
   * monotonic offsets to pick an active heading, which this supports.
   */
  getBoundingClientRect() {    let offset = 0;
    let node = this;
    while (node) {
      offset += node.offsetTop ?? 0;
      node = PARENT.get(node) ?? null;
    }
    const root = this.ownerDocument?.documentElement;
    const scroll = root?.scrollHostTop;
    const top = offset - (typeof scroll === "number" ? scroll : 0);
    return { top, bottom: top + 10, left: 0, right: 0, width: 0, height: 10, x: 0, y: top };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.ownerDocument?.registerId?.(this);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(child) {
    PARENT.set(child, this);
    this.childNodes.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  replaceChildren(...children) {
    this.childNodes = [];
    for (const child of children) this.appendChild(child);
  }
  remove() {
    const parent = PARENT.get(this);
    if (!parent) return;
    parent.childNodes = parent.childNodes.filter((node) => node !== this);
    this.isConnected = false;
  }
  contains(node) {
    if (node === this) return true;
    return this.childNodes.some((child) => child instanceof StubElement && child.contains(node));
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (matchesSelector(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((entry) => entry !== handler),
    );
  }
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) ?? [];
    for (const handler of [...list]) handler(event);
    return !event.defaultPrevented;
  }
  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }
  blur() {
    this.focused = false;
  }
  animate(keyframes, options) {
    const animation = new StubAnimation(keyframes, options);
    this.animations.push(animation);
    return animation;
  }
  getAnimations() {
    return this.animations.filter((animation) => animation.playState === "running");
  }

  // dialog surface
  showModal() {
    if (this.open) throw new Error("already open");
    this.open = true;
    this.ownerDocument.openDialog = this;
    this.dispatchEvent(createEvent("open"));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    if (this.ownerDocument.openDialog === this) this.ownerDocument.openDialog = null;
    this.dispatchEvent(createEvent("close"));
  }
}

function createEvent(type, extra = {}) {
  return {
    type,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...extra,
  };
}

export function createStubDocument(options = {}) {
  const viewport = { width: options.width ?? 1366, height: options.height ?? 768 };
  const doc = {
    openDialog: null,
    activeElement: null,
    head: null,
    body: null,
    listeners: new Map(),
    registeredIds: new Set(),
    createElement(tagName) {
      return new StubElement(doc, tagName);
    },
    createTextNode(data) {
      const node = { nodeType: 3, data: String(data), textContent: String(data), childNodes: [] };
      return node;
    },
    registerId(element) {
      doc.registeredIds.add(element.id);
    },
    getElementById(id) {
      return doc.body ? doc.body.querySelector(`#${id}`) : null;
    },
    querySelector(selector) {
      return doc.body ? doc.body.querySelector(selector) : null;
    },
    querySelectorAll(selector) {
      return doc.body ? doc.body.querySelectorAll(selector) : [];
    },
    addEventListener(type, handler) {
      const list = doc.listeners.get(type) ?? [];
      list.push(handler);
      doc.listeners.set(type, list);
    },
    removeEventListener(type, handler) {
      const list = doc.listeners.get(type) ?? [];
      doc.listeners.set(
        type,
        list.filter((entry) => entry !== handler),
      );
    },
    dispatchEvent(event) {
      for (const handler of doc.listeners.get(event.type) ?? []) handler(event);
      return true;
    },
  };

  doc.body = new StubElement(doc, "body");
  doc.head = new StubElement(doc, "head");
  doc.defaultView = {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    visualViewport: { offsetTop: 0, offsetLeft: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
    matchMedia(query) {
      return {
        media: query,
        matches: Boolean(options.reducedMotion) && query.includes("prefers-reduced-motion"),
        addEventListener() {},
        removeEventListener() {},
      };
    },
    addEventListener(type, handler) {
      doc.addEventListener(type, handler);
    },
    removeEventListener(type, handler) {
      doc.removeEventListener(type, handler);
    },
    sessionStorage: options.storage ?? null,
  };
  doc.defaultView.window = doc.defaultView;
  return doc;
}

export { createEvent, matchesSelector, StubAnimation };
