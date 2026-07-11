(() => {
  "use strict";

  const runtime = globalThis[Symbol.for("search-translate-guard.runtime")];
  if (!runtime) throw new Error("Search Translate Guard core must load before bootstrap");
  runtime.start();
})();
