"use client";

import { useEffect } from "react";

const TRANSLATIONS: Readonly<Record<string, string>> = {
  "Rendering...": "渲染中…",
  "Rendering": "渲染中",
  "Rendering (cold cache)": "渲染中（冷缓存）",
  "Rendering (cache disabled)": "渲染中（缓存已禁用）",
  "Compiling": "编译中",
  "Compiling...": "编译中…",
  "Loading...": "加载中…",
  "Route": "路由",
  "Static": "静态",
  "Dynamic": "动态",
  "Static Route": "静态路由",
  "Dynamic Route": "动态路由",
  "Bundler": "打包器",
  "Route Info": "路由信息",
  "Preferences": "偏好设置",
  "Theme": "主题",
  "Light": "浅色",
  "Dark": "深色",
  "System": "跟随系统",
  "Position": "位置",
  "Scale": "缩放",
  "Reset Bundler Cache": "重置打包缓存",
  "Reset Cache": "重置缓存",
  "Restart Dev Server": "重启开发服务器",
  "Cache": "缓存",
  "Cache Components": "缓存组件",
  "Request Insights": "请求洞察",
  "Requests": "请求",
  "Enabled": "已启用",
  "Disabled": "已禁用",
  "Refresh": "刷新",
  "Close": "关闭",
  "Cancel": "取消",
  "Save": "保存",
  "Copy": "复制",
  "Clear": "清除",
  "Error": "错误",
  "Errors": "错误",
  "Warnings": "警告",
  "Show": "显示",
  "Hide": "隐藏",
  "Disable": "禁用",
  "Show More": "显示更多",
  "Learn more": "了解更多",
  "Hide Dev Tools for this session": "本次会话隐藏开发工具",
  "Hide Dev Tools shortcut": "隐藏开发工具快捷键",
  "Disable Dev Tools for this project": "为此项目禁用开发工具",
  "Select your theme preference.": "选择开发工具主题。",
  "Adjust the placement of your dev tools.": "调整开发工具的位置。",
  "Adjust the size of your dev tools.": "调整开发工具的大小。",
  "Set a custom keyboard shortcut to toggle visibility.": "设置显示或隐藏开发工具的快捷键。",
  "Restarts the development server without needing to leave the browser.": "无需离开浏览器即可重启开发服务器。",
  "Turbopack is enabled.": "Turbopack 已启用。",
  "Learn about Turbopack and how to enable it in your application.": "了解 Turbopack 及其启用方式。",
  "Current route is static.": "当前路由为静态渲染。",
  "Current route is dynamic.": "当前路由为动态渲染。",
};

const TRANSLATABLE_ATTRIBUTES = ["aria-label", "title", "data-tooltip"] as const;

type TranslatableElement = Element & {
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
};

function translateValue(value: string): string {
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const contentEnd = trailing.length === 0 ? value.length : value.length - trailing.length;
  const trimmed = value.slice(leading.length, contentEnd);
  return `${leading}${TRANSLATIONS[trimmed] ?? trimmed}${trailing}`;
}

function translateShadowTree(root: ShadowRoot): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const current = textNode.nodeValue ?? "";
    const translated = translateValue(current);
    if (translated !== current) textNode.nodeValue = translated;
  }

  for (const element of root.querySelectorAll<TranslatableElement>("[aria-label], [title], [data-tooltip]")) {
    for (const attribute of TRANSLATABLE_ATTRIBUTES) {
      const current = element.getAttribute(attribute);
      if (!current) continue;
      const translated = translateValue(current);
      if (translated !== current) element.setAttribute(attribute, translated);
    }
  }
}

function getPortalRoot(portal: Element): ShadowRoot | null {
  return (portal as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * Next's development indicator is rendered in a private Shadow DOM and has no
 * locale option. Translate its stable labels without touching Next's package.
 */
export function NextDevToolsZh() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const portalObservers = new Map<Element, MutationObserver>();
    const translatePortals = () => {
      for (const portal of document.querySelectorAll("nextjs-portal")) {
        if (portalObservers.has(portal)) continue;
        const root = getPortalRoot(portal);
        if (!root) continue;
        translateShadowTree(root);
        const observer = new MutationObserver(() => translateShadowTree(root));
        observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
        });
        portalObservers.set(portal, observer);
      }
    };

    translatePortals();
    const documentObserver = new MutationObserver(translatePortals);
    documentObserver.observe(document.body, { childList: true, subtree: true });
    let retryCount = 0;
    const retryTimer = window.setInterval(() => {
      translatePortals();
      retryCount += 1;
      if (portalObservers.size > 0 || retryCount >= 40) window.clearInterval(retryTimer);
    }, 250);

    return () => {
      documentObserver.disconnect();
      window.clearInterval(retryTimer);
      for (const observer of portalObservers.values()) observer.disconnect();
      portalObservers.clear();
    };
  }, []);

  return null;
}
