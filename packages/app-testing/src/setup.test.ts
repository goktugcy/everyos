// @vitest-environment happy-dom
import "./setup.ts";
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";

describe("the test DOM setup", () => {
  it("keeps iterating after the current node is removed or unwrapped, as the DOM standard says", () => {
    document.body.innerHTML = "<div><b>1</b><i>2</i></div><p>3</p>";
    const iterator = document.createNodeIterator(document.body, NodeFilter.SHOW_ELEMENT);
    const seen: string[] = [];
    for (let node = iterator.nextNode(); node; node = iterator.nextNode()) {
      seen.push(node.nodeName);
      const element = node as Element;
      if (element.nodeName === "DIV") element.replaceWith(...element.childNodes);
      else if (element.nodeName === "I") element.remove();
    }
    expect(seen).toEqual(["BODY", "DIV", "B", "I", "P"]);
    expect(document.body.innerHTML).toBe("<b>1</b><p>3</p>");
  });

  it("answers nodeName through Node's own getter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, "nodeName")!;
    expect(descriptor.get!.call(document.createElement("h1"))).toBe("H1");
    expect(descriptor.get!.call(document.createTextNode("x"))).toBe("#text");
  });

  it("lets DOMPurify keep safe markup and remove the rest", () => {
    expect(
      DOMPurify.sanitize(
        '<h1>T</h1><p>a<script>alert(1)</script></p><b onclick="x">b</b><img src=x onerror="y"><a href="javascript:z">c</a><h3>d</h3>',
      ),
    ).toBe('<h1>T</h1><p>a</p><b>b</b><img src="x"><a>c</a><h3>d</h3>');
  });
});
