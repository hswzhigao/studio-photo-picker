import { createSSRApp, h, computed } from "vue";
import { renderToString } from "vue/server-renderer";
import { createMemoryHistory, createRouter, matchedRouteKey } from "vue-router";
import { describe, expect, it } from "vitest";
import { routes } from "./router.js";
import RetouchedViewer from "./components/RetouchedViewer.vue";
import RetouchedFeedback from "./components/RetouchedFeedback.vue";

async function renderRoute(path) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  expect(router.currentRoute.value.path).toBe(path);
  const component =
    router.currentRoute.value.matched.at(-1)?.components.default;
  const app = createSSRApp({ render: () => h(component || "div") });
  app.use(router);
  app.provide(
    matchedRouteKey,
    computed(() => router.currentRoute.value.matched.at(-1)),
  );
  app.provide("client", { actor: { actor_id: 1 } });
  app.provide("admin", { actor: { actor_id: 1 } });
  return renderToString(app);
}

const sample = {
  id: 11,
  asset_id: "a",
  filename: "finish.jpg",
  version: 2,
  status: "published",
  original_url: "/original/11",
  download_url: "/download/11",
};
const renderComponent = (component, props) =>
  renderToString(createSSRApp({ render: () => h(component, props) }));

describe("retouched delivery routes / SSR", () => {
  it("loads only the opened original and disables comparison without a linked before", async () => {
    const html = await renderComponent(RetouchedViewer, {
      photos: [sample, { ...sample, id: 12, original_url: "/original/12" }],
      index: 0,
      base: "/b",
    });
    expect(html).toContain('src="/original/11"');
    expect(html).not.toContain('src="/original/12"');
    expect(html).toMatch(/disabled[^>]*>查看修前/);
    expect(html).toContain('aria-modal="true"');
  });
  it("defaults feedback to private and blocks new feedback on historical versions", async () => {
    const current = await renderComponent(RetouchedFeedback, {
      base: "/b",
      photo: sample,
      current: true,
      identity: 7,
    });
    expect(current).toContain('value="studio_only" selected');
    const history = await renderComponent(RetouchedFeedback, {
      base: "/b",
      photo: sample,
      current: false,
      identity: 7,
    });
    expect(history).toContain("这是历史版本");
    expect(history).not.toContain("<textarea");
  });
  it("renders the independent client delivery page, without selection controls", async () => {
    const html = await renderRoute("/jobs/12/retouched");
    expect(html).toContain("精修后的照片");
    expect(html).toContain("正在加载精修照片");
    expect(html).not.toContain("选为精修");
  });
  it("renders the admin upload and delivery workflow", async () => {
    const html = await renderRoute("/admin/jobs/12/retouched");
    expect(html).toContain("精修交付");
    expect(html).toContain("上传精修照片");
    expect(html).toContain("image/jpeg,image/png");
  });
});
