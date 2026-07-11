(() => {
  "use strict";

  const runtimeSymbol = Symbol.for("search-translate-guard.runtime");
  if (globalThis[runtimeSymbol]) return;

  /**
   * @typedef {Object} GuardContext
   * @property {Document} document
   * @property {Location} location
   * @property {(element: Element) => void} protect
   * @property {(root: ParentNode | Element, selector: string) => Element[]} selectWithin
   */

  /**
   * @typedef {Object} ActivationRule
   * @property {string[]} events
   * @property {string} [selector]
   * @property {string} [key]
   * @property {boolean} [ignoreEditable]
   * @property {boolean} [unmodified]
   * @property {(event: Event, context: GuardContext) => boolean} [when]
   */

  /**
   * @typedef {Object} GuardAdapter
   * @property {string} id
   * @property {(url: URL) => boolean} matches
   * @property {{ select(root: ParentNode | Element, context: GuardContext): Iterable<Element> }} protection
   * @property {{ type: string, root(event: Event): ParentNode | Element | null | undefined }[]} [beforeAttachEvents]
   * @property {string[]} [rescanEvents]
   * @property {{
   *   activationRules: ActivationRule[],
   *   delayMs: number,
   *   isHealthy(context: GuardContext): boolean,
   *   recover(context: GuardContext): void
   * }} [recovery]
   */

  /** @type {GuardAdapter[]} */
  const adapters = [];
  let started = false;

  function protect(element) {
    if (!(element instanceof Element)) return;
    element.setAttribute("translate", "no");
    element.classList.add("notranslate");
  }

  function selectWithin(root, selector) {
    const matches = [];
    if (root instanceof Element && root.matches(selector)) matches.push(root);
    root?.querySelectorAll?.(selector).forEach((element) => matches.push(element));
    return matches;
  }

  function isEditable(target) {
    const element = target instanceof Element ? target : target?.parentElement;
    return Boolean(element?.closest(
      'input, textarea, select, [contenteditable="true"], [role="textbox"]'
    ));
  }

  function registerAdapter(adapter) {
    if (started) throw new Error("Guard adapters must be registered before start()");
    if (!adapter || typeof adapter.id !== "string" || !adapter.id) {
      throw new TypeError("Guard adapter id must be a non-empty string");
    }
    if (adapters.some((candidate) => candidate.id === adapter.id)) {
      throw new Error(`Guard adapter already registered: ${adapter.id}`);
    }
    if (typeof adapter.matches !== "function" || typeof adapter.protection?.select !== "function") {
      throw new TypeError(`Guard adapter ${adapter.id} is missing matches() or protection.select()`);
    }
    adapters.push(adapter);
  }

  function ruleMatches(rule, event, context) {
    if (!rule.events.includes(event.type)) return false;
    if (rule.key !== undefined && !(event instanceof KeyboardEvent && event.key === rule.key)) {
      return false;
    }
    if (
      rule.unmodified &&
      event instanceof KeyboardEvent &&
      (event.ctrlKey || event.altKey || event.metaKey)
    ) {
      return false;
    }
    if (rule.ignoreEditable && isEditable(event.target)) return false;

    if (rule.selector) {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target?.closest(rule.selector)) return false;
    }

    return rule.when ? Boolean(rule.when(event, context)) : true;
  }

  function start() {
    if (started) return;
    started = true;

    const url = new URL(location.href);
    const activeAdapters = adapters.filter((adapter) => adapter.matches(url));
    if (!activeAdapters.length) return;

    const contexts = new Map(activeAdapters.map((adapter) => [adapter, {
      document,
      location,
      protect,
      selectWithin
    }]));
    const timers = new Map();

    const scan = (adapter, root) => {
      if (
        !(root instanceof Element) &&
        !(root instanceof Document) &&
        !(root instanceof DocumentFragment)
      ) {
        return;
      }

      const context = contexts.get(adapter);
      for (const element of adapter.protection.select(root, context) ?? []) protect(element);
    };

    const scanAll = (root) => {
      for (const adapter of activeAdapters) scan(adapter, root);
    };

    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) scanAll(node);
      }
    }).observe(document, { childList: true, subtree: true });

    scanAll(document);

    for (const adapter of activeAdapters) {
      for (const hook of adapter.beforeAttachEvents ?? []) {
        document.addEventListener(hook.type, (event) => {
          scan(adapter, hook.root(event));
        }, true);
      }

      for (const eventType of adapter.rescanEvents ?? []) {
        document.addEventListener(eventType, () => scan(adapter, document), true);
      }

      if (!adapter.recovery) continue;

      const scheduleRecoveryCheck = () => {
        clearTimeout(timers.get(adapter));
        timers.set(adapter, setTimeout(() => {
          const context = contexts.get(adapter);
          if (!adapter.recovery.isHealthy(context)) adapter.recovery.recover(context);
        }, adapter.recovery.delayMs));
      };

      const eventTypes = new Set(
        adapter.recovery.activationRules.flatMap((rule) => rule.events)
      );
      for (const eventType of eventTypes) {
        document.addEventListener(eventType, (event) => {
          const context = contexts.get(adapter);
          if (adapter.recovery.activationRules.some((rule) => ruleMatches(rule, event, context))) {
            scheduleRecoveryCheck();
          }
        }, true);
      }
    }
  }

  Object.defineProperty(globalThis, runtimeSymbol, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ protect, registerAdapter, selectWithin, start })
  });
})();
