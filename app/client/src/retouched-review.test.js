import { createRenderer, h, markRaw, nextTick, reactive } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Vue from "vue";
import { readFileSync } from "node:fs";
import { compileScript, parse } from "@vue/compiler-sfc";
import * as retouchedUtils from "./utils/retouched";

// Vitest's default SFC pipeline is SSR-only. Compile these same sources with
// the client inline template so the host renderer exercises lifecycle/events.
function clientComponent(file, components = {}) {
  let source = readFileSync(new URL(file, import.meta.url), "utf8");
  // Test-only access to the exact reload invoked by uploads and viewer events.
  if (file.includes("views/admin/")) source = source.replace("</script>", "defineExpose({ load });\n</script>");
  const { descriptor } = parse(source);
  let code = compileScript(descriptor, { id: file, inlineTemplate: true }).content;
  code = code.replace(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?/g, (_, names, from) => {
    const bindings = names.replace(/\bas\b/g, ":");
    const key = from === "vue" ? "Vue" : from === "vue-router" ? "router" : from.endsWith("api") ? "apiModule" : "utils";
    return `const {${bindings}} = dependencies.${key};`;
  }).replace(/import\s+(\w+)\s+from\s+["'][^"']+["'];?/g, (_, name) => `const ${name} = dependencies.components.${name};`)
    .replace(/import\s+["'][^"']+["'];?/g, "")
    .replace("export default", "return");
  return new Function("dependencies", code)({ Vue, utils: retouchedUtils, apiModule: { api: { get, upload: async () => ({}) } }, router: { useRoute: () => route, onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} }, components });
}


const { get, route } = vi.hoisted(() => ({ get: vi.fn(), route: { params: { id: 12 } } }));
vi.mock("./api", () => ({ api: { get } }));
vi.mock("vue-router", () => ({ useRoute: () => route, onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} }));

const RetouchedFeedback = clientComponent("./components/RetouchedFeedback.vue");
const RetouchedViewer = clientComponent("./components/RetouchedViewer.vue", { RetouchedFeedback });
const Retouched = clientComponent("./views/admin/Retouched.vue", { RetouchedViewer });

// Real Vue components/events with a small host renderer; no browser/DOM dependency.
function node(tag, text = "") {
  return markRaw({ tag, tagName: tag.toUpperCase(), text, props: {}, children: [], parent: null,
    focus() { document.activeElement = this; },
    addEventListener() {}, removeEventListener() {},
    get options() { return this.children.filter(n => n.tag === "option"); },
    get value() { return this.props.value; }, set value(value) { this.props.value = value; },
    get tabIndex() { return this.props.tabindex !== undefined ? Number(this.props.tabindex) : /^(button|input|textarea|select|a)$/.test(tag) ? 0 : -1; },
    matches(selector) { return selector === ":disabled" && (!!this.props.disabled || (this.parent?.tag === "fieldset" && this.parent.props.disabled)); },
    getClientRects() { return this.props.hidden || this.props.style?.display === "none" ? [] : [{}]; },
    closest() { return this.props.hidden || this.props.inert ? this : this.parent?.closest() || null; },
    querySelectorAll() { return all(this).filter(n => /^(button|a|input|textarea|select|summary)$/.test(n.tag) || n.props.tabindex !== undefined || n.props.contenteditable); },
  });
}
function all(n) { return n.children.flatMap(c => [c, ...all(c)]); }
const renderer = createRenderer({
  createElement: node, createText: text => node("#text", text), createComment: text => node("#comment", text),
  setText: (n, text) => n.text = text, setElementText: (n, text) => { n.text = text; n.children = []; },
  patchProp: (n, k, _old, value) => n.props[k] = value,
  insert(n, parent, anchor) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = parent; const i = parent.children.indexOf(anchor); parent.children.splice(i < 0 ? parent.children.length : i, 0, n); },
  remove(n) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = null; },
  parentNode: n => n.parent, nextSibling: n => n.parent?.children[n.parent.children.indexOf(n) + 1],
});
const apps = [];
function mount(component, props) {
  vi.stubGlobal("document", { activeElement: null, body: { style: { overflow: "" } } });
  vi.stubGlobal("getComputedStyle", n => ({ visibility: n.props.style?.visibility || "visible" }));
  const root = node("root"), state = reactive(props);
  const app = renderer.createApp({ render: () => h(component, state) });
  app.mount(root); apps.push(app);
  return { root, state, find: predicate => all(root).find(predicate) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
const text = n => [n.text, ...n.children.map(text)].join(" ");
const photo = id => ({ id, asset_id: `a${id}`, filename: `${id}.jpg`, version: 1, status: "published", original_url: `/original/${id}`, download_url: `/download/${id}` });
const viewer = () => mount(RetouchedViewer, { photos: [photo(1), photo(2)], index: 0, base: "/b", current: true });
afterEach(() => { apps.splice(0).forEach(a => a.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });
get.mockImplementation(async () => ({ comments: [], photos: [] }));

describe("review regressions: actual component lifecycle and key handlers", () => {
  it("shows original loading until load, then really replaces a failed current image on retry", async () => {
    const v = viewer(); await flush();
    expect(text(v.root)).toContain("正在加载原文件");
    let image = v.find(n => n.tag === "img");
    image.props.onLoad(); await flush();
    expect(text(v.root)).not.toContain("正在加载原文件");
    image.props.onError(); await flush();
    const retry = v.find(n => n.tag === "button" && text(n).includes("重试"));
    expect(retry).toBeTruthy(); retry.props.onClick(); await flush();
    expect(v.find(n => n.tag === "img")).not.toBe(image);
    expect(text(v.root)).toContain("正在加载原文件");
    v.find(n => n.tag === "img").props.onLoad(); await flush();
    expect(text(v.root)).not.toContain("原文件加载失败");
  });
  it("ignores detached image callbacks after a fast photo switch", async () => {
    const v = viewer(); await flush(); const old = v.find(n => n.tag === "img");
    v.state.index = 1; await flush();
    old.props.onError(); await flush();
    expect(text(v.root)).not.toContain("原文件加载失败");
    expect(text(v.root)).toContain("正在加载原文件");
    old.props.onLoad?.(); await flush();
    expect(text(v.root)).toContain("正在加载原文件");
    v.find(n => n.tag === "img").props.onLoad(); await flush();
    expect(text(v.root)).not.toContain("正在加载原文件");
  });
  it("traps forward/reverse Tab while feedback fields are disabled, and recovers removed/dialog focus", async () => {
    const v = viewer(); await flush();
    const dialog = v.find(n => n.props.role === "dialog"), close = v.find(n => n.props["aria-label"] === "关闭查看器");
    const download = v.find(n => n.tag === "a" && n.props.download !== undefined);
    all(v.root).filter(n => /^(textarea|select)$/.test(n.tag) || text(n).trim() === "刷新").forEach(n => n.props.disabled = true);
    const tab = (active, shiftKey = false) => { document.activeElement = active; const event = { key: "Tab", shiftKey, preventDefault: vi.fn() }; dialog.props.onKeydown(event); return event; };
    expect(tab(download).preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(close);
    expect(tab(close, true).preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(download);
    expect(tab(dialog).preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(close);
    expect(tab(node("button")).preventDefault).toHaveBeenCalled(); expect(document.activeElement).toBe(close);
  });
  it("does not claim no feedback after failed GET", async () => {
    get.mockRejectedValueOnce(new Error("network unavailable"));
    const v = mount(RetouchedFeedback, { base: "/b", photo: photo(1), current: true }); await flush();
    expect(text(v.root)).toContain("network unavailable");
    expect(text(v.root)).not.toContain("还没有反馈");
  });
  it("clears a failed list GET after a later successful upload-triggered load", async () => {
    get.mockImplementation(async url => {
      if (url.includes("/photos?")) return { photos: [] };
      throw new Error("old list error");
    });
    const v = mount(Retouched, {}); await flush();
    expect(text(v.root)).toContain("old list error");
    get.mockResolvedValue({ photos: [] });
    await apps.at(-1)._instance.subTree.component.exposed.load(); await flush();
    expect(text(v.root)).not.toContain("old list error");
  });
  it("only offers ready visible undeleted originals and clears stale list load errors after success", async () => {
    get.mockImplementation(async url => {
      if (url.includes("/photos?")) return { photos: [
        { id: 1, filename: "allowed.jpg", import_status: "ready", hidden: 0 },
        { id: 2, filename: "hidden.jpg", import_status: "ready", hidden: 1 },
        { id: 3, filename: "processing.jpg", import_status: "processing", hidden: 0 },
        { id: 4, filename: "deleted.jpg", import_status: "ready", hidden: 0, deleted_at: "2026-11-15" },
      ] };
      throw new Error("old list error");
    });
    const v = mount(Retouched, {}); await flush();
    expect(text(v.root)).toContain("allowed.jpg");
    expect(text(v.root)).not.toContain("hidden.jpg");
    expect(text(v.root)).not.toContain("processing.jpg");
    expect(text(v.root)).not.toContain("deleted.jpg");
    get.mockResolvedValue({ photos: [] });
    const input = v.find(n => n.tag === "input" && n.props.type === "file");
    await input.props.onChange({ target: { files: [{ name: "new.jpg", type: "image/jpeg" }], value: "new.jpg" } }); await flush();
    expect(text(v.root)).not.toContain("old list error");
  });
});
