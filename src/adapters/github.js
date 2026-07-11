(() => {
  "use strict";

  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  if (!runtime) throw new Error("Search Translate Guard core must load before adapters");

  const searchRootSelector = "qbsearch-input";
  const redesignedTriggerSelector = [
    '[data-testid="top-nav-center"] button[aria-label^="Search or jump to"]',
    '[data-testid="top-nav-center"] button[class*="Search-module__searchButton__"]',
    '[data-testid="top-nav-center"] button[class*="Search-module__smallSearchButton__"]'
  ].join(",");
  const protectedSearchSelector = [searchRootSelector, redesignedTriggerSelector].join(",");
  const triggerSelector = [
    '[data-target="qbsearch-input.inputButton"]',
    "qbsearch-input .search-input-container",
    "qbsearch-input .header-search-button",
    ".AppHeader-search button",
    redesignedTriggerSelector
  ].join(",");

  let fallbackHost = null;
  let fallbackInput = null;
  let launcherHost = null;
  let launcherContext = null;
  let launcherTimer = null;
  let launcherObserver = null;
  let launcherWaitsForDom = false;

  function message(key, fallback) {
    try {
      return globalThis.chrome?.i18n?.getMessage(key) || fallback;
    } catch {
      return fallback;
    }
  }

  const text = {
    title: message("fallbackTitle", "GitHub Search"),
    notice: message(
      "fallbackNotice",
      "Native search did not open reliably. Compatibility search is active."
    ),
    inputLabel: message("fallbackInputLabel", "GitHub search query"),
    searchButton: message("searchButton", "Search"),
    hint: message("fallbackHint", "Enter to search · Esc to close"),
    launcher: message("fallbackLauncher", "Compatibility search")
  };

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) return false;
    if (typeof element.checkVisibility === "function") {
      return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function hasVisibleNativeTrigger(context) {
    return Array.from(context.document.querySelectorAll(triggerSelector)).some(isVisible);
  }

  function nativeSearchIsUsable(context) {
    return Array.from(context.document.querySelectorAll(searchRootSelector)).some((root) => {
      const input = root.querySelector(
        '#query-builder-test, input[role="combobox"], query-builder input'
      );
      const rect = input?.getBoundingClientRect();

      return Boolean(
        root.classList.contains("expanded") &&
        input &&
        rect &&
        rect.width > 40 &&
        rect.height > 10
      );
    });
  }

  function currentScope(context) {
    return context.document.querySelector(`${searchRootSelector}[data-scope]`)
      ?.getAttribute("data-scope")
      ?.trim() || "";
  }

  function closeFallback() {
    if (fallbackHost) fallbackHost.hidden = true;
    if (launcherContext) scheduleLauncherUpdate(launcherContext);
  }

  function buildLauncher(context) {
    if (launcherHost?.isConnected) return;

    launcherHost = context.document.createElement("div");
    launcherHost.id = "github-search-translate-guard-launcher";
    launcherHost.hidden = true;
    context.protect(launcherHost);
    const shadow = launcherHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; position: fixed; right: 18px; bottom: 18px; z-index: 2147483646; }
        :host([hidden]) { display: none; }
        button {
          min-height: 38px; border: 1px solid rgba(31, 35, 40, .15);
          border-radius: 999px; padding: 0 16px; cursor: pointer;
          color: #fff; background: #0969da;
          box-shadow: 0 8px 24px rgba(1, 4, 9, .28);
          font: 600 14px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        button:focus-visible { outline: 3px solid rgba(9, 105, 218, .35); outline-offset: 2px; }
        @media (prefers-color-scheme: dark) {
          button { color: #0d1117; background: #58a6ff; border-color: #8c959f; }
        }
      </style>
      <button type="button" aria-label="${text.launcher}">${text.launcher}</button>`;
    const launcherButton = shadow.querySelector("button");
    launcherButton.addEventListener("click", () => openFallback(context));
    context.document.documentElement.append(launcherHost);
  }

  function updateLauncher(context) {
    launcherTimer = null;
    if (context.document.readyState === "loading") {
      if (!launcherWaitsForDom) {
        launcherWaitsForDom = true;
        context.document.addEventListener("DOMContentLoaded", () => {
          launcherWaitsForDom = false;
          scheduleLauncherUpdate(context);
        }, { once: true });
      }
      return;
    }
    buildLauncher(context);
    if (!launcherHost) return;
    const fallbackOpen = Boolean(fallbackHost?.isConnected && fallbackHost.hidden === false);
    launcherHost.hidden = fallbackOpen || hasVisibleNativeTrigger(context);
  }

  function scheduleLauncherUpdate(context) {
    launcherContext = context;
    if (launcherTimer !== null) return;
    launcherTimer = setTimeout(() => updateLauncher(context), 100);
  }

  function monitorLauncher(context) {
    launcherContext = context;
    if (!launcherObserver) {
      launcherObserver = new MutationObserver(() => scheduleLauncherUpdate(context));
      launcherObserver.observe(context.document, { childList: true, subtree: true });
      globalThis.addEventListener("resize", () => scheduleLauncherUpdate(context), {
        passive: true
      });
    }
    scheduleLauncherUpdate(context);
  }

  function buildFallback(context) {
    if (fallbackHost?.isConnected) return;

    fallbackHost = context.document.createElement("div");
    fallbackHost.id = "github-search-translate-guard";
    context.protect(fallbackHost);
    fallbackHost.hidden = true;

    const shadow = fallbackHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        :host([hidden]) { display: none; }
        .backdrop {
          position: fixed; inset: 0; z-index: 2147483647;
          display: grid; place-items: start center;
          padding: min(12vh, 96px) 16px 16px;
          background: rgba(1, 4, 9, .55);
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .dialog {
          width: min(720px, calc(100vw - 32px));
          box-sizing: border-box; border: 1px solid #d0d7de;
          border-radius: 12px; padding: 16px;
          color: #1f2328; background: #fff;
          box-shadow: 0 16px 48px rgba(1, 4, 9, .35);
        }
        .title { margin: 0 0 6px; font-size: 16px; font-weight: 600; }
        .note { margin: 0 0 12px; color: #636c76; font-size: 12px; }
        form { display: flex; gap: 8px; }
        input {
          min-width: 0; flex: 1; box-sizing: border-box;
          height: 38px; border: 1px solid #8c959f; border-radius: 6px;
          padding: 0 10px; color: #1f2328; background: #fff;
          font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          outline: none;
        }
        input:focus { border-color: #0969da; box-shadow: 0 0 0 3px rgba(9, 105, 218, .25); }
        button {
          height: 38px; border: 1px solid rgba(31, 35, 40, .15);
          border-radius: 6px; padding: 0 16px; cursor: pointer;
          color: #fff; background: #1f883d; font-weight: 600;
        }
        .hint { margin: 10px 0 0; color: #636c76; font-size: 12px; }
        kbd { border: 1px solid #d0d7de; border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; }
        @media (prefers-color-scheme: dark) {
          .dialog { color: #f0f6fc; background: #0d1117; border-color: #30363d; }
          .note, .hint { color: #8b949e; }
          input { color: #f0f6fc; background: #0d1117; border-color: #8b949e; }
          kbd { border-color: #30363d; }
        }
      </style>
      <div class="backdrop" role="presentation">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="gstg-title">
          <h1 class="title" id="gstg-title">${text.title}</h1>
          <p class="note">${text.notice}</p>
          <form>
            <input type="text" autocomplete="off" spellcheck="false" aria-label="${text.inputLabel}">
            <button type="submit">${text.searchButton}</button>
          </form>
          <p class="hint">${text.hint}</p>
        </section>
      </div>`;

    fallbackInput = shadow.querySelector("input");
    shadow.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const query = fallbackInput.value.trim();
      if (!query) return;

      const url = new URL("/search", context.location.origin);
      url.searchParams.set("q", query);
      context.location.assign(url.href);
    });

    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeFallback();
    });

    (context.document.body || context.document.documentElement).append(fallbackHost);
  }

  function openFallback(context) {
    buildFallback(context);
    if (!fallbackHost) return;

    fallbackHost.hidden = false;
    if (launcherHost) launcherHost.hidden = true;
    const scope = currentScope(context);
    if (!fallbackInput.value && scope) fallbackInput.value = `${scope} `;
    requestAnimationFrame(() => {
      fallbackInput.focus();
      fallbackInput.setSelectionRange(fallbackInput.value.length, fallbackInput.value.length);
    });
  }

  runtime.registerAdapter({
    id: "github-search",
    matches: (url) => url.protocol === "https:" && url.hostname === "github.com",
    protection: {
      select: (root, context) => {
        monitorLauncher(context);
        return runtime.selectWithin(root, protectedSearchSelector);
      }
    },
    beforeAttachEvents: [{
      type: "turbo:before-render",
      root: (event) => event.detail?.newBody
    }],
    rescanEvents: ["turbo:render", "turbo:load"],
    recovery: {
      delayMs: 550,
      activationRules: [
        { events: ["pointerdown", "click"], selector: triggerSelector },
        {
          events: ["keydown"],
          key: "/",
          ignoreEditable: true,
          unmodified: true,
          when: () => fallbackHost?.hidden !== false
        }
      ],
      isHealthy: nativeSearchIsUsable,
      recover: openFallback
    }
  });
})();
