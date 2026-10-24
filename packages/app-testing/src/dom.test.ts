// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { byRole } from "./dom.ts";

describe("byRole", () => {
  it("names controls by aria-label, a label for them, the label around them or their text", () => {
    document.body.innerHTML = `
      <button aria-label="Close window">×</button>
      <label for="city">City</label><input id="city">
      <label class="check"><input type="checkbox"><span>Remember me</span></label>
      <label><span>Size</span><select><option>S</option></select></label>
      <div role="treeitem">src</div>
      <label>Outer <button>Inner</button></label>`;
    expect(byRole("button", "Close window")?.textContent).toBe("×");
    expect(byRole("textbox", "City")?.id).toBe("city");
    expect(byRole("checkbox", "Remember me")).not.toBeNull();
    expect(byRole("combobox", "Size")).not.toBeNull();
    expect(byRole("treeitem", "src")).not.toBeNull();
    // Only form controls take the name of the label around them.
    expect(byRole("button", "Inner")).not.toBeNull();
    expect(byRole("checkbox", "Nope")).toBeNull();
  });
});

it("finds native and explicit search boxes by accessible name", () => {
  document.body.innerHTML =
    '<label for="native-search">Find ports</label><input id="native-search" type="search"><div role="searchbox" aria-label="Find services"></div><input type="text" aria-label="Not a search box">';
  expect(byRole("searchbox", "Find ports")?.id).toBe("native-search");
  expect(byRole("searchbox", "Find services")?.getAttribute("role")).toBe("searchbox");
  expect(byRole("searchbox", "Not a search box")).toBeNull();
});
