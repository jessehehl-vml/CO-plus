(() => {
  const slot = document.getElementById("tag-slot");
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  let requestId = null;
  let dynamicResponse = null;
  let fallbackResponse = null;
  let rendered = false;
  let completed = false;
  let renderTimeout = null;
  let renderCompleteTimer = null;

  function report(error = null) {
    if (!requestId || completed) return;
    completed = true;
    clearTimeout(renderTimeout);
    clearTimeout(renderCompleteTimer);
    window.parent.postMessage(
      {
        type: "co-plus-production-tag-result",
        requestId,
        status: dynamicResponse?.status,
        response: dynamicResponse?.response,
        requestContext: dynamicResponse?.requestContext || null,
        fallbackUsed: Boolean(fallbackResponse),
        error: error || dynamicResponse?.error || fallbackResponse?.error,
      },
      "*",
    );
  }

  function finishWhenReady() {
    if (completed) return;
    if (dynamicResponse && dynamicResponse.status >= 200 && dynamicResponse.status < 300) {
      if (rendered) {
        if (!renderCompleteTimer) {
          renderCompleteTimer = setTimeout(() => report(), 1_000);
        }
      } else if (!renderTimeout) {
        renderTimeout = setTimeout(
          () => report("Tag content was received, but the creative did not finish rendering."),
          12_000,
        );
      }
      return;
    }

    if (fallbackResponse && rendered) {
      report("The production tag used its fallback content.");
      return;
    }

    if ((dynamicResponse || fallbackResponse) && !renderTimeout) {
      renderTimeout = setTimeout(() => {
        const errorMessage =
          fallbackResponse && (fallbackResponse.status < 200 || fallbackResponse.status >= 300)
            ? `The production fallback failed (HTTP ${fallbackResponse.status}).`
            : dynamicResponse && (dynamicResponse.status < 200 || dynamicResponse.status >= 300)
              ? `Production content request failed (HTTP ${dynamicResponse.status}).`
              : "The production creative did not finish rendering.";
        report(errorMessage);
      }, 12_000);
    }
  }

  // The content server targets on the request body's context, e.g.
  // { context: { location: { "postal-code": "SO14" } } }, flattened here to
  // "location.postal-code".
  function readBodyContext(requestBody) {
    if (typeof requestBody !== "string") return null;
    try {
      const context = JSON.parse(requestBody)?.context;
      if (!context || typeof context !== "object") return null;
      const flat = {};
      for (const [alias, values] of Object.entries(context)) {
        if (!values || typeof values !== "object") continue;
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === "string" && value !== "REPLACEWITHYOURMACRO") {
            flat[`${alias}.${key}`] = value;
          }
        }
      }
      return flat;
    } catch {
      return null;
    }
  }

  function captureResponse(url, status, responseText, networkError = false, requestBody) {
    let target;
    let requestContext = null;
    try {
      const parsedUrl = new URL(url, location.href);
      if (
        parsedUrl.hostname === "content.lemonpi.io" &&
        /\/v1\/a\/\d+\/c\/\d+\/d\/t\/\d+\/w\/\d+\/h\/\d+$/.test(
          parsedUrl.pathname,
        )
      ) {
        target = "dynamic";
        // Report the non-placeholder values actually sent: the body context
        // the server targets on, or the query-string copy if there is no body.
        requestContext =
          readBodyContext(requestBody) ||
          Object.fromEntries(
            [...parsedUrl.searchParams].filter(
              ([key, value]) => key !== "impression-id" && value !== "REPLACEWITHYOURMACRO",
            ),
          );
      } else if (
        parsedUrl.hostname === "creative-content.lemonpi.io" &&
        parsedUrl.pathname.startsWith("/adset/fallback/")
      ) {
        target = "fallback";
      }
    } catch {
      return;
    }
    if (!target) return;

    let body = null;
    let parseError = null;
    if (responseText) {
      try {
        body = JSON.parse(responseText);
      } catch {
        parseError = "The production endpoint returned invalid JSON.";
      }
    }

    const result = {
      status,
      requestContext,
      response: body,
      error: networkError
        ? "The production content request failed."
        : parseError,
    };
    if (target === "dynamic") dynamicResponse = result;
    else fallbackResponse = result;
    finishWhenReady();
  }

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__coPlusRequestUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__coPlusRequestUrl || "";
    const requestBody = args[0];
    this.addEventListener(
      "load",
      () => captureResponse(url, this.status, this.responseText, false, requestBody),
      { once: true },
    );
    this.addEventListener(
      "error",
      () => captureResponse(url, this.status, "", true, requestBody),
      { once: true },
    );
    return originalSend.apply(this, args);
  };

  document.addEventListener(
    "load",
    (event) => {
      if (
        event.target instanceof HTMLIFrameElement &&
        event.target.id.startsWith("lemonpi-display-tags")
      ) {
        rendered = true;
        finishWhenReady();
      }
    },
    true,
  );

  function installSimulatedClock(minuteOfDay) {
    if (
      !Number.isInteger(minuteOfDay) ||
      minuteOfDay < 0 ||
      minuteOfDay >= 24 * 60
    ) {
      return;
    }
    const RealDate = Date;
    const now = new RealDate();
    const target = new RealDate(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Math.floor(minuteOfDay / 60),
      minuteOfDay % 60,
    );
    const offset = target.getTime() - now.getTime();
    // The production tag sends `new Date()` as the request timestamp, which
    // drives `${datetime.time-of-day}` targeting.
    function SimulatedDate(...args) {
      if (!new.target) return new RealDate(RealDate.now() + offset).toString();
      return args.length
        ? new RealDate(...args)
        : new RealDate(RealDate.now() + offset);
    }
    SimulatedDate.prototype = RealDate.prototype;
    SimulatedDate.now = () => RealDate.now() + offset;
    SimulatedDate.parse = RealDate.parse;
    SimulatedDate.UTC = RealDate.UTC;
    window.Date = SimulatedDate;
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== window.parent ||
      message?.type !== "co-plus-run-production-tag" ||
      typeof message.requestId !== "string" ||
      !message.signals ||
      typeof message.signals !== "object"
    ) {
      return;
    }

    requestId = message.requestId;
    installSimulatedClock(message.simulatedMinute);
    const ins = document.createElement("ins");
    ins.style.width = `${message.width}px`;
    ins.style.height = `${message.height}px`;
    const script = document.createElement("script");
    const attributes = {
      "data-width": String(message.width),
      "data-height": String(message.height),
      "data-lemonpi-config": message.encodedConfig,
      "data-click-tag": "${CLICK_URL}",
      "data-gdpr": "${GDPR}",
      "data-gdpr-consent": "${GDPR_CONSENT_98}",
      "data-dsp-signal-key1": "dsp-signal.dsp-ioid",
      "data-dsp-signal-value1": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key2": "dsp-signal.dsp-site-url",
      "data-dsp-signal-value2": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key3": "dsp-signal.dsp-placementid",
      "data-dsp-signal-value3": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key4": "dsp-signal.dsp-linecode",
      "data-dsp-signal-value4": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key5": "dsp-signal.dsp-dealid",
      "data-dsp-signal-value5": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key6": "dsp-signal.dsp-advertiserid",
      "data-dsp-signal-value6": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key8": "dsp-signal.dsp-publisherid",
      "data-dsp-signal-value8": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key9": "dsp-signal.dsp-auctionid",
      "data-dsp-signal-value9": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key10": "dsp-signal.dsp-creativeid",
      "data-dsp-signal-value10": "REPLACEWITHYOURMACRO",
      "data-dsp-signal-key11": "dsp-signal.dsp-lineid",
      "data-dsp-signal-value11": "REPLACEWITHYOURMACRO",
    };
    // Simulated signals replace a macro's value, or are added as new numbered
    // key/value pairs, which the tag sends as request context
    // (e.g. "location.postal-code" → context.location["postal-code"]).
    let nextIndex = 12;
    for (const [key, value] of Object.entries(message.signals)) {
      if (!/^[\w-]+(\.[\w-]+)+$/.test(key) || typeof value !== "string") continue;
      const existing = Object.keys(attributes).find(
        (name) => name.startsWith("data-dsp-signal-key") && attributes[name] === key,
      );
      const index = existing
        ? existing.slice("data-dsp-signal-key".length)
        : String(nextIndex++);
      attributes[`data-dsp-signal-key${index}`] = key;
      attributes[`data-dsp-signal-value${index}`] = value;
    }
    for (const [name, value] of Object.entries(attributes)) {
      script.setAttribute(name, value);
    }

    script.src = "https://creative-libraries.lemonpi.io/v1/display-tag.js";
    script.onerror = () => report("Could not load the production tag script.");
    ins.appendChild(script);
    slot.replaceChildren(ins);
  });
})();
