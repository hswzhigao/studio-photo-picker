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
  // Test-only access to the exact reload invoked by pair flows and viewer events.
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
  return new Function("dependencies", code)({ Vue, utils: retouchedUtils, apiModule: { api: { get, patch, post, upload: async () => ({}) } }, router: { useRoute: () => route, onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} }, components });
}


const { get, patch, post, route, confirmStub } = vi.hoisted(() => ({
  get: vi.fn(), patch: vi.fn(), post: vi.fn(),
  route: { params: { id: 12 } },
  confirmStub: vi.fn(() => true),
}));
vi.mock("./api", () => ({ api: { get, patch, post } }));
vi.mock("vue-router", () => ({ useRoute: () => route, onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} }));

const RetouchedFeedback = clientComponent("./components/RetouchedFeedback.vue");
const RetouchedViewer = clientComponent("./components/RetouchedViewer.vue", { RetouchedFeedback });
const RetouchedPairPicker = clientComponent("./components/RetouchedPairPicker.vue");
const Retouched = clientComponent("./views/admin/Retouched.vue", { RetouchedViewer, RetouchedPairPicker });

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
  parentNode: n => n.parent, nextSibling: n => n.parent.children[n.parent.children.indexOf(n) + 1] || null,
});
const apps = [];
function mount(component, props) {
  vi.stubGlobal("document", { activeElement: null, body: { style: { overflow: "" } } });
  vi.stubGlobal("getComputedStyle", n => ({ visibility: n.props.style?.visibility || "visible" }));
  vi.stubGlobal("window", { confirm: confirmStub, scrollTo: vi.fn() });
  const root = node("root"), state = reactive(props);
  const app = renderer.createApp({ render: () => h(component, state) });
  app.mount(root); apps.push(app);
  return { root, state, find: predicate => all(root).find(predicate) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick(); };
const text = n => [n.text, ...n.children.map(text)].join(" ");
const originals = () => [
  { id: 101, filename: "IMG_0001.jpg", display_name: "海边", thumb_url: "/thumbs/101", import_status: "ready", hidden: 0 },
  { id: 102, filename: "IMG_0002.jpg", display_name: "树下", thumb_url: "/thumbs/102", import_status: "ready", hidden: 0 },
  { id: 103, filename: "IMG_0003.jpg", display_name: "回眸", thumb_url: "/thumbs/103", import_status: "ready", hidden: 0 },
];
const draftCard = () => ({ id: 5, asset_id: "a5", filename: "r5.jpg", version: 1, status: "ready", photo_id: null, thumb_url: "/thumbs/r5", comment_count: 0, versions: [{ id: 5, version: 1, status: "ready" }] });
const publishedCard = () => ({ id: 7, asset_id: "a7", filename: "r7.jpg", version: 2, status: "published", photo_id: 201, thumb_url: "/thumbs/r7", comment_count: 0, versions: [{ id: 7, version: 2, status: "published" }] });
function mountRetouched(cards) {
  const calls = [], originalList = originals();
  post.mockImplementation(async (url, body) => { calls.push(["post", url, body]); return { photos: [] }; });
  patch.mockImplementation(async (url, body) => { calls.push(["patch", url, body]); return { photo: {} }; });
  get.mockImplementation(async (url) => url.includes("/photos?") ? { photos: originalList, pagination: { has_more: false } } : { photos: cards() });
  const v = mount(Retouched, {});
  return Object.assign(v, { calls });
}
const listGets = () => get.mock.calls.filter(([url]) => url === "/api/admin/jobs/12/retouched").length;
const openCardPicker = async (v, label) => {
  v.find(n => n.tag === "button" && text(n).includes(label)).props.onClick(); await flush();
  return v.find(n => n.props.role === "dialog");
};
const pickAndConfirm = async (v, id) => {
  v.find(n => n.tag === "button" && text(n).includes(`#${id}`)).props.onClick(); await flush();
  v.find(n => n.tag === "button" && text(n).includes("确认关联")).props.onClick(); await flush();
};
afterEach(() => { apps.splice(0).forEach(a => a.unmount()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("pair picker: thumbnails, filtering and dialog behavior", () => {
  it("renders every original as a thumbnail with id and display name, marking the current pair", async () => {
    const v = mount(RetouchedPairPicker, { originals: originals(), currentId: 102, busy: false, onClose: vi.fn(), onSelect: vi.fn() });
    await flush();
    const body = text(v.root);
    expect(body).toContain("#101"); expect(body).toContain("海边");
    expect(body).toContain("#102"); expect(body).toContain("树下");
    expect(body).toContain("#103");
    for (const id of [101, 102, 103]) expect(v.find(n => n.tag === "img" && n.props.src === `/thumbs/${id}`)).toBeTruthy();
    const current = v.find(n => n.tag === "button" && text(n).includes("当前关联"));
    expect(text(current)).toContain("#102");
  });
  it("filters by file name and id, with an explicit empty state", async () => {
    const v = mount(RetouchedPairPicker, { originals: originals(), currentId: null, busy: false, onClose: vi.fn(), onSelect: vi.fn() });
    await flush();
    const filter = v.find(n => n.tag === "input" && n.props.type === "search");
    filter.props.onInput({ target: { value: "IMG_0002" } }); await flush();
    expect(text(v.root)).toContain("#102");
    expect(text(v.root)).not.toContain("#101"); expect(text(v.root)).not.toContain("#103");
    filter.props.onInput({ target: { value: "103" } }); await flush();
    expect(text(v.root)).toContain("#103");
    expect(text(v.root)).not.toContain("#101");
    filter.props.onInput({ target: { value: "nothing" } }); await flush();
    expect(text(v.root)).toContain("没有匹配的原片");
  });
  it("closes on Escape and backdrop click, traps Tab like the viewer, and disables while busy", async () => {
    const close = vi.fn();
    const v = mount(RetouchedPairPicker, { originals: originals(), currentId: null, busy: false, onClose: close, onSelect: vi.fn() });
    await flush();
    const dialog = v.find(n => n.props.role === "dialog");
    expect(document.activeElement?.props?.role).toBe("dialog");
    const escape = { key: "Escape", preventDefault: vi.fn() };
    dialog.props.onKeydown(escape);
    expect(escape.preventDefault).toHaveBeenCalled(); expect(close).toHaveBeenCalled();
    const backdrop = v.find(n => n.tag === "div" && String(n.props.class).includes("rt-backdrop"));
    backdrop.props.onClick({ target: backdrop, currentTarget: backdrop });
    expect(close).toHaveBeenCalledTimes(2);
    const tab = (active, shiftKey = false) => { document.activeElement = active; const event = { key: "Tab", shiftKey, preventDefault: vi.fn() }; dialog.props.onKeydown(event); return event; };
    const closeBtn = v.find(n => n.props["aria-label"] === "关闭选择器");
    const cancel = v.find(n => n.tag === "button" && text(n).trim() === "取消");
    tab(dialog); expect(document.activeElement).toBe(closeBtn);
    tab(closeBtn, true); expect(document.activeElement).toBe(cancel);
    const busy = mount(RetouchedPairPicker, { originals: originals(), currentId: null, busy: true, onClose: vi.fn(), onSelect: vi.fn() });
    await flush();
    expect(busy.find(n => n.tag === "button" && text(n).includes("确认关联")).props.disabled).toBeTruthy();
    expect(busy.find(n => n.tag === "button" && text(n).includes("#101")).props.disabled).toBeTruthy();
  });
});

describe("pair picker flows in the admin delivery page", () => {
  it("patches a draft card directly, without confirm or withdraw/publish", async () => {
    const v = mountRetouched(() => [draftCard()]); await flush();
    await openCardPicker(v, "关联原片");
    await pickAndConfirm(v, 101);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/api/admin/jobs/12/retouched/5", { photo_id: 101 });
    expect(post).not.toHaveBeenCalled();
    expect(confirmStub).not.toHaveBeenCalled();
    expect(v.find(n => n.props.role === "dialog")).toBeFalsy();
    expect(text(v.root)).not.toContain("失败");
  });
  it("re-associates a published card via withdraw, patch then publish in order", async () => {
    confirmStub.mockReturnValue(true);
    const v = mountRetouched(() => [publishedCard()]); await flush();
    await openCardPicker(v, "重新关联");
    await pickAndConfirm(v, 102);
    expect(confirmStub).toHaveBeenCalledTimes(1);
    expect(v.calls).toEqual([
      ["post", "/api/admin/jobs/12/retouched/withdraw", { ids: [7] }],
      ["patch", "/api/admin/jobs/12/retouched/7", { photo_id: 102 }],
      ["post", "/api/admin/jobs/12/retouched/publish", { ids: [7] }],
    ]);
    expect(text(v.root)).not.toContain("失败");
  });
  it("sends zero requests when the confirm dialog is cancelled or the pair is unchanged", async () => {
    confirmStub.mockReturnValue(false);
    let v = mountRetouched(() => [publishedCard()]); await flush();
    await openCardPicker(v, "重新关联");
    await pickAndConfirm(v, 102);
    expect(confirmStub).toHaveBeenCalledTimes(1);
    expect(v.calls).toEqual([]);
    expect(v.find(n => n.props.role === "dialog")).toBeFalsy();
    confirmStub.mockReturnValue(true);
    confirmStub.mockClear();
    v = mountRetouched(() => [publishedCard()]); await flush();
    await openCardPicker(v, "重新关联");
    v.find(n => n.tag === "button" && text(n).includes("确认关联")).props.onClick(); await flush();
    expect(confirmStub).not.toHaveBeenCalled();
    expect(v.calls).toEqual([]);
  });
  it("stops after a mid-flow failure, shows the error with a manual-publish hint and refreshes the list", async () => {
    confirmStub.mockReturnValue(true);
    const v = mountRetouched(() => [publishedCard()]); await flush();
    expect(listGets()).toBe(1);
    patch.mockRejectedValueOnce(new Error("关联被拒绝"));
    await openCardPicker(v, "重新关联");
    await pickAndConfirm(v, 102);
    expect(v.calls).toEqual([["post", "/api/admin/jobs/12/retouched/withdraw", { ids: [7] }]]);
    expect(text(v.root)).toContain("关联被拒绝");
    expect(text(v.root)).toContain("手动发布");
    expect(listGets()).toBe(2);
  });
  it("selects and clears the upload-panel pair locally, without any request", async () => {
    const v = mountRetouched(() => []); await flush();
    v.find(n => n.tag === "button" && text(n).includes("选择修前原片")).props.onClick(); await flush();
    await pickAndConfirm(v, 102);
    expect(patch).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    expect(text(v.root)).toContain("#102");
    expect(v.find(n => n.tag === "img" && n.props.src === "/thumbs/102")).toBeTruthy();
    v.find(n => n.tag === "button" && text(n).includes("清空")).props.onClick(); await flush();
    expect(text(v.root)).toContain("选择修前原片");
    expect(v.find(n => n.tag === "img" && n.props.src === "/thumbs/102")).toBeFalsy();
  });
});
