// Runs in the page's own JS world (see manifest). It records the Authorization header the app itself
// sends to the Lemonpi API (and the API accepted), so the extension can reuse the token that is valid for *this* tab.
// localStorage is shared between windows and can hold another advertiser's session.
(() => {
  const ATTR = "data-co-plus-auth";
  const isLemonpi = (url) => {
    try {
      return new URL(url, location.href).hostname.endsWith("lemonpi.io");
    } catch {
      return false;
    }
  };
  const remember = (value) => {
    if (value && /^lemonpi\s+\S+/i.test(value)) {
      document.documentElement.setAttribute(ATTR, value);
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let auth = null;
    try {
      const url = typeof input === "string" ? input : input?.url;
      if (isLemonpi(url)) {
        const headers = new Headers(init?.headers || input?.headers || {});
        auth = headers.get("Authorization");
      }
    } catch {
      // never break the page's own requests
    }
    const result = originalFetch.apply(this, arguments);
    // Only tokens the API accepted: another window can swap the shared session under this tab
    if (auth) {
      result.then((res) => res.ok && remember(auth)).catch(() => {});
    }
    return result;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__coPlusLemonpi = isLemonpi(url);
    this.__coPlusAuth = null;
    if (this.__coPlusLemonpi) {
      this.addEventListener("loadend", () => {
        if (this.status >= 200 && this.status < 400)
          remember(this.__coPlusAuth);
      });
    }
    return originalOpen.apply(this, arguments);
  };

  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__coPlusLemonpi && /^authorization$/i.test(name)) {
      this.__coPlusAuth = value;
    }
    return originalSetHeader.apply(this, arguments);
  };
})();
