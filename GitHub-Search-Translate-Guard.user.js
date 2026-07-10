// ==UserScript==
// @name         Search Translate Guard for GitHub
// @namespace    local.github-search-translate-guard
// @version      2.0.0
// @description  Keep GitHub search usable during automatic page translation, with a local fallback dialog when needed.
// @match        https://github.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const searchRootSelector = "qbsearch-input";
  const triggerSelector = [
    '[data-target="qbsearch-input.inputButton"]',
    "qbsearch-input .search-input-container",
    "qbsearch-input .header-search-button",
    ".AppHeader-search button"
  ].join(",");

  let fallbackTimer = 0;
  let fallbackHost = null;
  let fallbackInput = null;

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
    hint: message("fallbackHint", "Enter to search · Esc to close")
  };

  function protect(element) {
    element.setAttribute("translate", "no");
    element.classList.add("notranslate");
  }

  function scan(node) {
    if (!(node instanceof Element) && node !== document) return;

    if (node instanceof Element && node.matches(searchRootSelector)) {
      protect(node);
    }

    node.querySelectorAll?.(searchRootSelector).forEach(protect);
  }

  // Early protection for the initial HTML stream and later DOM replacements.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) scan(node);
    }
  }).observe(document, { childList: true, subtree: true });

  scan(document);

  // GitHub Turbo exposes the replacement body before it is attached. Marking
  // it here closes the timing gap on in-site navigation.
  document.addEventListener("turbo:before-render", (event) => {
    scan(event.detail?.newBody);
  }, true);
  document.addEventListener("turbo:render", () => scan(document), true);
  document.addEventListener("turbo:load", () => scan(document), true);

  function isEditable(target) {
    return target instanceof Element && Boolean(target.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]'
    ));
  }

  function nativeSearchIsUsable() {
    const root = document.querySelector(searchRootSelector);
    const input = root?.querySelector(
      '#query-builder-test, input[role="combobox"], query-builder input'
    );
    const rect = input?.getBoundingClientRect();

    return Boolean(
      root?.classList.contains("expanded") &&
      input &&
      rect &&
      rect.width > 40 &&
      rect.height > 10
    );
  }

  function currentScope() {
    return document.querySelector(`${searchRootSelector}[data-scope]`)
      ?.getAttribute("data-scope")
      ?.trim() || "";
  }

  function buildFallback() {
    if (fallbackHost?.isConnected) return;

    fallbackHost = document.createElement("div");
    fallbackHost.id = "github-search-translate-guard";
    protect(fallbackHost);
    fallbackHost.hidden = true;

    const shadow = fallbackHost.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
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
    const backdrop = shadow.querySelector(".backdrop");

    shadow.querySelector("form").addEventListener("submit", (event) => {
      event.preventDefault();
      const query = fallbackInput.value.trim();
      if (!query) return;

      const url = new URL("/search", location.origin);
      url.searchParams.set("q", query);
      location.assign(url.href);
    });

    shadow.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeFallback();
    });

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeFallback();
    });

    (document.body || document.documentElement).append(fallbackHost);
  }

  function openFallback() {
    buildFallback();
    if (!fallbackHost) return;

    fallbackHost.hidden = false;
    const scope = currentScope();
    if (!fallbackInput.value && scope) fallbackInput.value = `${scope} `;
    requestAnimationFrame(() => {
      fallbackInput.focus();
      fallbackInput.setSelectionRange(fallbackInput.value.length, fallbackInput.value.length);
    });
  }

  function closeFallback() {
    if (fallbackHost) fallbackHost.hidden = true;
  }

  function verifyOrFallback() {
    clearTimeout(fallbackTimer);
    fallbackTimer = setTimeout(() => {
      if (!nativeSearchIsUsable()) openFallback();
    }, 550);
  }

  // Do not replace a working native search. If Edge translation makes it
  // disappear or prevents focus, the compatibility dialog opens after 550 ms.
  document.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest(triggerSelector)) {
      verifyOrFallback();
    }
  }, true);

  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(triggerSelector)) {
      verifyOrFallback();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (
      event.key === "/" &&
      !event.ctrlKey && !event.altKey && !event.metaKey &&
      !isEditable(event.target) &&
      fallbackHost?.hidden !== false
    ) {
      verifyOrFallback();
    }
  }, true);
})();
