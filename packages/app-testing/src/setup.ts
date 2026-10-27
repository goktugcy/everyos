/*
 * Fixes gaps of test DOMs that make correct app code fail in tests. Add it to Vitest's
 * `setupFiles` (`@everyos/app-testing/setup`); it changes nothing in a real browser, where it is
 * never loaded.
 *
 * Both matter for sanitizers such as DOMPurify, which then drop safe content and leave the rest
 * unchecked in happy-dom:
 *
 * - NodeIterator: happy-dom's iterator stops when the node it returned last is removed. This one
 *   continues from the node that preceded the removed one, as the DOM standard says.
 * - `Node.prototype.nodeName`: the standard defines it once, on Node; happy-dom's returns "" there
 *   and overrides it in subclasses, so code that reads it through Node's getter (to resist DOM
 *   clobbering) sees no names. Node's getter now answers like the subclass's.
 */

const SHOW_ALL = 0xffffffff;
const FILTER_ACCEPT = 1;

function following(node: Node, root: Node): Node | null {
  if (node.firstChild) return node.firstChild;
  for (let current: Node | null = node; current && current !== root; current = current.parentNode)
    if (current.nextSibling) return current.nextSibling;
  return null;
}

function preceding(node: Node, root: Node): Node | null {
  if (node === root) return null;
  let previous = node.previousSibling;
  if (!previous) return node.parentNode;
  while (previous.lastChild) previous = previous.lastChild;
  return previous;
}

class StandardNodeIterator {
  readonly root: Node;
  readonly whatToShow: number;
  readonly filter: NodeFilter | null;
  #reference: Node;
  #before = true;
  /** What preceded the reference node when it was returned (where to go on if it is removed). */
  #previous: Node | null = null;

  constructor(root: Node, whatToShow = SHOW_ALL, filter: NodeFilter | null = null) {
    this.root = root;
    this.whatToShow = whatToShow;
    this.filter = filter;
    this.#reference = root;
  }

  get referenceNode(): Node {
    return this.#reference;
  }

  get pointerBeforeReferenceNode(): boolean {
    return this.#before;
  }

  #accepts(node: Node): boolean {
    if (!((this.whatToShow >>> (node.nodeType - 1)) & 1)) return false;
    if (!this.filter) return true;
    const result =
      typeof this.filter === "function" ? this.filter(node) : this.filter.acceptNode(node);
    return result === FILTER_ACCEPT;
  }

  #attached(node: Node): boolean {
    return node === this.root || this.root.contains(node);
  }

  nextNode(): Node | null {
    let node: Node | null = this.#reference;
    let before = this.#before;
    if (!this.#attached(node)) {
      node = this.#previous && this.#attached(this.#previous) ? this.#previous : this.root;
      before = false;
    }
    for (;;) {
      if (before) before = false;
      else {
        node = following(node, this.root);
        if (!node) return null;
      }
      if (this.#accepts(node)) {
        this.#reference = node;
        this.#before = false;
        this.#previous = preceding(node, this.root);
        return node;
      }
    }
  }

  previousNode(): Node | null {
    let node: Node | null = this.#reference;
    let before = this.#before;
    for (;;) {
      if (!before) before = true;
      else {
        node = preceding(node, this.root);
        if (!node) return null;
      }
      if (this.#accepts(node)) {
        this.#reference = node;
        this.#before = true;
        return node;
      }
    }
  }

  detach(): void {}
}

/** The prototype in `object`'s chain that defines `name` itself. */
function owner(object: object, name: string): object | null {
  for (
    let proto = Object.getPrototypeOf(object) as object | null;
    proto;
    proto = Object.getPrototypeOf(proto) as object | null
  )
    if (Object.prototype.hasOwnProperty.call(proto, name)) return proto;
  return null;
}

if (typeof document !== "undefined" && typeof Node !== "undefined") {
  for (const proto of new Set([owner(document, "createNodeIterator"), Document.prototype]))
    if (proto)
      Object.defineProperty(proto, "createNodeIterator", {
        configurable: true,
        writable: true,
        value: (root: Node, whatToShow?: number, filter?: NodeFilter | null) =>
          new StandardNodeIterator(root, whatToShow, filter) as unknown as NodeIterator,
      });

  const base = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName");
  if (base?.get && !base.get.call(document.createElement("p")))
    Object.defineProperty(Node.prototype, "nodeName", {
      configurable: true,
      get(this: Node) {
        for (
          let proto = Object.getPrototypeOf(this) as object | null;
          proto && proto !== Node.prototype;
          proto = Object.getPrototypeOf(proto) as object | null
        ) {
          const own = Object.getOwnPropertyDescriptor(proto, "nodeName");
          if (own?.get) return own.get.call(this) as string;
        }
        return base.get!.call(this) as string;
      },
    });
}

export {};
