(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const money = new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH" });
  const price = kop => Number.isSafeInteger(kop) ? money.format(kop / 100) : "Ціну уточнюйте";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const MAX_QUANTITY = 20;
  const MAX_ORDER_QUANTITY = 100;
  const quantityLimitReached = quantity => quantity >= MAX_QUANTITY || cart.reduce((sum,item)=>sum+item.quantity,0) >= MAX_ORDER_QUANTITY;
  const CART_KEY = "loza-cart-v2", PENDING_KEY = "loza-checkout-pending-v2";
  const timeoutSignal = milliseconds => {
    if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(milliseconds);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds);
    return controller.signal;
  };
  const validId = id => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
  const validKey = key => typeof key === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const normalizeCart = input => {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    return input.filter(item => {
      if (!item || !validId(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY || seen.has(item.productId) || seen.size >= 20) return false;
      seen.add(item.productId);
      return true;
    }).map(item => ({ productId: item.productId, quantity: item.quantity }));
  };
  const readCart = () => {
    try { return normalizeCart(JSON.parse(localStorage.getItem(CART_KEY) || "[]")); }
    catch { return []; }
  };
  let cart = readCart(), products = [], config = null, quoted = null, quoteLoading = false;
  let quoteRevision = 0, quoteTimer, quoteController, pending = null, pendingPayload = null;
  let inFlight = false, recovering = false, receiptShown = false, token = "", widgetId = null, turnstileLoading = null;
  let returnFocus = null, catalogLoaded = false;

  const makeKey = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  };
  const itemsKey = items => JSON.stringify([...items].sort((a, b) => a.productId.localeCompare(b.productId, "en")));
  const findProduct = id => products.find(product => product.id === id);
  const quantityOf = id => cart.find(item => item.productId === id)?.quantity || 0;
  const feedback = (message, tone = "") => {
    $("#storeFeedback").textContent = message;
    $("#storeFeedback").dataset.tone = tone;
  };
  const saveCart = () => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); }
    catch { feedback("Браузер не дозволяє зберегти кошик після перезавантаження.", "error"); }
  };
  const savePending = () => {
    try {
      if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
      else sessionStorage.removeItem(PENDING_KEY);
    } catch { /* In-memory protection still applies when storage is unavailable. */ }
  };
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
    const items = normalizeCart(saved?.items);
    if (validKey(saved?.key) && items.length) {
      pending = { key: saved.key, items };
      cart = items.map(item => ({ ...item }));
    }
  } catch { /* No personal data is stored in either cart or pending-request storage. */ }

  async function api(path, options = {}) {
    let response;
    try { response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options }); }
    catch (cause) {
      const error = new Error("Не вдалося зв’язатися з сервером. Перевірте інтернет та повторіть спробу.");
      error.code = cause.name === "AbortError" ? "ABORTED" : "NETWORK";
      throw error;
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) {
      const error = new Error(typeof data?.error === "string" ? data.error : "Сервер тимчасово недоступний. Спробуйте пізніше.");
      error.status = response.status; error.code = data?.code; error.retryAfter = data?.retryAfter;
      throw error;
    }
    return data;
  }

  function toast(title, detail = "") {
    $("#toastTitle").textContent = title;
    $("#toastDetail").textContent = detail;
    $("#toast").classList.add("show");
    clearTimeout(window.lozaToastTimer);
    window.lozaToastTimer = setTimeout(() => $("#toast").classList.remove("show"), 5000);
  }

  function renderCatalog() {
    if (!catalogLoaded) return;
    const query = $("#search").value.trim().toLocaleLowerCase("uk");
    const ripening = $("#ripening").value.toLocaleLowerCase("uk");
    const color = $("#color").value;
    const kishmish = $("#kishmish").value;
    const minimum = $("#priceMin").value === "" ? null : Number($("#priceMin").value) * 100;
    const maximum = $("#priceMax").value === "" ? null : Number($("#priceMax").value) * 100;
    const shown = products.filter(product => {
      const details = product.details || {};
      return (!query || product.name.toLocaleLowerCase("uk").includes(query)) &&
        (!ripening || String(details.ripening || "").toLocaleLowerCase("uk") === ripening) &&
        (!color || String(details.color || "").toLocaleLowerCase("uk") === color) &&
        (!kishmish || Boolean(details.kishmish) === (kishmish === "1")) &&
        (minimum === null || (product.priceKop !== null && product.priceKop >= minimum)) &&
        (maximum === null || (product.priceKop !== null && product.priceKop <= maximum));
    });
    $("#count").textContent = `Показано: ${shown.length} із ${products.length}`;
    $("#catalogSize").textContent = String(products.length);
    $("#grid").innerHTML = shown.length ? shown.map(product => {
      const d = product.details || {}, quantity = quantityOf(product.id);
      const available = product.inStock && product.available && product.priceConfirmed;
      return `<article class="card catalog-card is-visible${available ? "" : " unavailable"}" data-product-id="${esc(product.id)}">
        <div class="cardhead"><span class="tag">${esc(d.ripening || "Потребує перевірки")}</span>${d.kishmish ? '<span class="kishmish-badge">Кишмиш</span>' : ""}</div>
        <h3 class="title">${esc(product.name)}</h3>
        <dl class="catalog-facts">${[["Колір",d.color],["Смак",d.taste],["Ягода",d.berry],["Форма",d.shape],["Морозостійкість",d.frost]].map(([label,value])=>`<div><dt>${esc(label)}</dt><dd>${esc(value || "Потребує перевірки")}</dd></div>`).join("")}</dl>
        <p class="catalog-review">${product.characteristicsConfirmed ? "Характеристики підтверджено власником" : "Характеристики з каталогу · потребують перевірки"}</p>
        <div class="catalog-price"><strong class="price">${esc(price(product.priceKop))}</strong>${product.priceKop !== null ? '<span>за лозу</span>' : ""}</div>
        ${product.priceKop !== null && !product.priceConfirmed ? '<p class="catalog-price-note">Ціна з PDF · очікує підтвердження</p>' : ""}
        <p class="store-stock${product.inStock ? "" : " store-unavailable"}">${product.inStock ? "В наявності" : "Немає в наявності"}</p>
        ${quantity ? `<div class="quantity-control"><button type="button" data-action="decrease" data-id="${esc(product.id)}" aria-label="Зменшити кількість ${esc(product.name)}" ${pending ? "disabled" : ""}>−</button><span><strong>${quantity}</strong><small>у кошику</small></span><button type="button" data-action="increase" data-id="${esc(product.id)}" aria-label="Збільшити кількість ${esc(product.name)}" ${pending || !available || quantityLimitReached(quantity) ? "disabled" : ""}>+</button></div>` :
          `<button class="add" type="button" data-action="increase" data-id="${esc(product.id)}" ${pending || !available ? "disabled" : ""}>${available ? "Додати до кошика" : product.priceKop === null ? "Замовлення недоступне" : !product.inStock ? "Замовлення недоступне" : !product.priceConfirmed ? "Ціна очікує підтвердження" : "Замовлення недоступне"}</button>`}
      </article>`;
    }).join("") : '<p class="store-load">За цими умовами товарів не знайдено.</p>';
    $("#varietySuggestions").innerHTML = query ? products.filter(product => product.name.toLocaleLowerCase("uk").startsWith(query)).slice(0, 10).map(product => `<option value="${esc(product.name)}"></option>`).join("") : "";
  }

  function updateControls() {
    const empty = !cart.length;
    $("#cartCount").textContent = String(cart.reduce((sum, item) => sum + item.quantity, 0));
    $("#storeForm").hidden = empty || receiptShown;
    $("#storeSummary").hidden = empty || receiptShown;
    $("#cartLines").hidden = receiptShown;
    $("#storeReceipt").hidden = !receiptShown;
    $("#storeRecovery").hidden = !pending || receiptShown;
    $("#storeRecoverButton").disabled = recovering || inFlight;
    $("#storeFields").disabled = inFlight || Boolean(pendingPayload);
    $("#storeSubmit").disabled = inFlight || recovering || !config?.checkoutAvailable || !token || (!pending && (!quoted || quoteLoading));
    $("#storeSubmit").textContent = inFlight ? "Створюємо замовлення…" : pending ? "Повторити надсилання" : "Оформити замовлення";
    $("#storeTotal").textContent = quoted ? price(quoted.amountKop) : quoteLoading ? "Розраховуємо…" : "—";
    $("#storeRefreshQuote").hidden = !cart.length || receiptShown || Boolean(quoted) || quoteLoading || Boolean(pending);
    $("#storeForm").setAttribute("aria-busy", String(inFlight));
  }

  function renderCart() {
    const byId = new Map((quoted?.lines || []).map(line => [line.productId, line]));
    $("#cartLines").innerHTML = cart.length ? cart.map(item => {
      const product = findProduct(item.productId), line = byId.get(item.productId);
      const unavailable = !product?.inStock || !product?.available || !product?.priceConfirmed || item.quantity > MAX_QUANTITY;
      return `<div class="cartrow"><div><strong>${esc(product?.name || "Товар тимчасово недоступний")}</strong>
        <div class="hint">${esc(price(product?.priceKop))} за штуку</div>
        ${unavailable ? '<div class="store-stock store-unavailable">Наявність або ціна змінилася. Приберіть сорт або зверніться в підтримку.</div>' : ""}
        <div class="store-line-total">${line ? esc(price(line.lineTotalKop)) : quoteLoading ? "Розраховуємо…" : "—"}</div>
        <button class="remove" type="button" data-action="remove" data-id="${esc(item.productId)}" ${pending ? "disabled" : ""}>Прибрати</button></div>
        <div class="qty"><button type="button" data-action="decrease" data-id="${esc(item.productId)}" aria-label="Зменшити кількість ${esc(product?.name || "товару")}" ${pending ? "disabled" : ""}>−</button><output aria-label="Кількість">${item.quantity}</output><button type="button" data-action="increase" data-id="${esc(item.productId)}" aria-label="Збільшити кількість ${esc(product?.name || "товару")}" ${pending || !product?.available || quantityLimitReached(item.quantity) ? "disabled" : ""}>+</button></div></div>`;
    }).join("") : '<div class="empty">Кошик поки порожній. Додайте товар із каталогу.</div>';
    updateControls();
  }

  function scheduleQuote() {
    clearTimeout(quoteTimer);
    quoteController?.abort();
    const revision = ++quoteRevision;
    quoted = null;
    quoteLoading = Boolean(cart.length);
    renderCart();
    if (!cart.length) return;
    quoteTimer = setTimeout(async () => {
      const requested = itemsKey(cart);
      const controller = new AbortController();
      quoteController = controller;
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const result = await api("/api/cart/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: cart }), signal: controller.signal });
        if (revision !== quoteRevision || requested !== itemsKey(cart)) return;
        if (!Number.isSafeInteger(result.amountKop) || !Array.isArray(result.lines)) throw new Error("Не вдалося розрахувати кошик.");
        quoted = result;
      } catch (error) {
        if (revision === quoteRevision) feedback(error.message, "error");
      } finally {
        clearTimeout(timeout);
        if (revision === quoteRevision) { quoteLoading = false; renderCart(); }
      }
    }, 120);
  }

  function changeCart(id, delta, remove = false) {
    if (pending || inFlight) return;
    const current = quantityOf(id), product = findProduct(id);
    const next = remove ? 0 : current + delta;
    if (next > current && (!product?.available || next > MAX_QUANTITY || cart.reduce((sum,item)=>sum+item.quantity,0)+1>MAX_ORDER_QUANTITY || (!current && cart.length >= 20))) {
      toast("Не вдалося збільшити кількість", "До 20 лоз одного сорту та до 100 лоз загалом у замовленні. До 20 різних сортів.");
      return;
    }
    cart = cart.filter(item => item.productId !== id);
    if (next > 0) cart.push({ productId: id, quantity: next });
    receiptShown = false;
    saveCart(); feedback(""); renderCatalog(); scheduleQuote();
    if (next > current) toast("Додано до кошика", product.name);
  }

  function loadTurnstile() { return window.lozaLoadTurnstile(); }

  async function mountTurnstile() {
    if (!config?.checkoutAvailable || !cart.length || receiptShown) return;
    try {
      const turnstile = await loadTurnstile();
      if (!$("#overlay").classList.contains("show") || receiptShown) return;
      if (widgetId !== null) { turnstile.reset(widgetId); return; }
      widgetId = turnstile.render("#storeTurnstile", {
        sitekey: config.turnstileSiteKey, action: "loza_checkout", theme: "light", size: "flexible", language: "uk",
        callback: value => { token = value; updateControls(); },
        "expired-callback": () => { token = ""; updateControls(); },
        "error-callback": () => { token = ""; feedback("Не вдалося завершити перевірку. Спробуйте ще раз.", "error"); updateControls(); },
        "timeout-callback": () => { token = ""; updateControls(); },
      });
    } catch (error) { feedback(error.message, "error"); }
  }

  function resetTurnstile() {
    token = "";
    if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
    updateControls();
  }

  function openCart() {
    returnFocus = document.activeElement;
    $("#toast").classList.remove("show");
    $("#overlay").classList.add("show");
    document.body.style.overflow = "hidden";
    document.querySelectorAll("header, main, footer").forEach(element => { element.inert = true; });
    renderCart();
    $("#closeCart").focus();
    if (!config?.checkoutAvailable && cart.length) feedback("Оформлення тимчасово недоступне. Спробуйте пізніше.", "error");
    if (!pending && cart.length) scheduleQuote();
    void mountTurnstile();
  }

  function closeCart() {
    $("#overlay").classList.remove("show");
    document.body.style.overflow = "";
    document.querySelectorAll("header, main, footer").forEach(element => { element.inert = false; });
    if (widgetId !== null && window.turnstile) window.turnstile.remove(widgetId);
    widgetId = null; token = "";
    returnFocus?.focus();
  }

  function showReceipt(data, submittedItems) {
    if (typeof data.orderId !== "string" || !Number.isSafeInteger(data.amountKop) || data.amountKop <= 0 || data.currency !== "UAH") throw new Error("Підтвердження має незрозумілий формат. Перевірте попередній запит.");
    $("#storeOrderNumber").textContent = data.orderId;
    $("#storeOrderAmount").textContent = price(data.amountKop);
    $("#storeOrderStatus").textContent = data.status === "pending" ? "Очікує підтвердження" : "Статус оновлено продавцем";
    const latest = readCart();
    // Remove purchased quantities only; other tabs may have added more items.
    cart = latest.length ? latest : cart;
    for (const item of submittedItems) {
      const line = cart.find(line => line.productId === item.productId);
      if (line) line.quantity -= item.quantity;
    }
    cart = cart.filter(item => item.quantity > 0);
    saveCart();
    pending = null; pendingPayload = null; savePending();
    quoted = null; quoteLoading = false; quoteRevision++; quoteController?.abort(); clearTimeout(quoteTimer);
    receiptShown = true;
    $("#storeForm").reset();
    feedback(""); renderCatalog(); renderCart();
    $("#storeReceiptTitle").focus();
    toast("Замовлення створено", "Номер і суму показано в кошику.");
    void loadCatalog(false);
  }

  async function recover(showMissing = true) {
    if (!pending || recovering || inFlight) return;
    recovering = true; updateControls();
    try {
      const key = pending.key, submitted = pending.items;
      const data = await api("/api/orders/receipt", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: "{}", signal: timeoutSignal(12000) });
      showReceipt(data, submitted);
      if (!$("#overlay").classList.contains("show")) openCart();
    } catch (error) {
      if (showMissing || error.status !== 404) feedback(error.message, "error");
    } finally { recovering = false; updateControls(); }
  }

  $("#storeForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (inFlight || recovering || receiptShown) return;
    if (!$("#storeForm").reportValidity()) return;
    if (!token) { feedback("Пройдіть перевірку перед надсиланням.", "error"); return; }
    if (!pending && (!quoted || quoteLoading || !cart.length)) { feedback("Дочекайтеся розрахунку кошика.", "error"); return; }
    const input = pendingPayload || {
      items: pending ? pending.items : cart.map(item => ({ ...item })),
      customer: { name: $("#storeBuyer").value.trim(), phone: $("#storePhone").value.trim() },
      delivery: { city: $("#storeCity").value.trim(), method: $("#storeDelivery").value, branch: $("#storeBranch").value.trim() },
      comment: $("#storeComment").value.trim(),
    };
    pending ||= { key: makeKey(), items: input.items.map(item => ({ ...item })) };
    pendingPayload = input;
    savePending(); inFlight = true; feedback("Створюємо замовлення…"); updateControls(); renderCatalog(); renderCart();
    try {
      const result = await api("/api/orders/create", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: JSON.stringify({ ...input, turnstileToken: token }), signal: timeoutSignal(25000) });
      showReceipt(result, input.items);
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        pendingPayload = null;
        feedback("Попередній запит уже прийнято. Натисніть «Перевірити попередній запит».", "error");
      } else if (["INVALID_DETAILS", "INVALID_ITEMS", "INVALID_BODY", "INVALID_FORMAT", "INVALID_KEY", "STOCK_UNAVAILABLE", "FORBIDDEN"].includes(error.code)) {
        pending = null; pendingPayload = null; savePending();
        feedback(error.message, "error");
        if (error.code === "STOCK_UNAVAILABLE") { await loadCatalog(false); scheduleQuote(); }
      } else {
        const suffix = error.retryAfter ? ` Повторіть через ${error.retryAfter} с.` : " Повторна спроба використає той самий ключ і не створить замовлення двічі.";
        feedback(error.message + suffix, "error");
      }
    } finally { inFlight = false; resetTurnstile(); renderCart(); renderCatalog(); }
  });

  async function loadCatalog(initial = true) {
    try {
      const result = await api("/api/products", { signal: timeoutSignal(12000) });
      if (!Array.isArray(result.products)) throw new Error("Не вдалося завантажити товари.");
      products = result.products.filter(product => validId(product.id) && typeof product.name === "string");
      catalogLoaded = true;
      for (const [id,key,title] of [["ripening","ripening","Усі терміни"],["color","color","Усі кольори"]]) {
        const select = $("#"+id), selected = select.value;
        const terms = new Map();
        for (const product of products) { const value = product.details?.[key]; if (typeof value === "string" && value) terms.set(value.toLocaleLowerCase("uk"),value); }
        select.innerHTML = `<option value="">${title}</option>` + [...terms].sort((a,b)=>a[0].localeCompare(b[0],"uk")).map(([value,label])=>`<option value="${esc(value)}">${esc(label)}</option>`).join("");
        if (terms.has(selected)) select.value = selected;
      }
      $("#storeNotice").textContent = "Ціни й характеристики перенесені з каталогу власника. Купівля доступна для сортів у наявності з підтвердженою ціною. Онлайн-оплата вимкнена.";
      renderCatalog();
      if (initial) scheduleQuote();
    } catch (error) {
      if (initial) $("#grid").innerHTML = '<div class="store-load">Не вдалося завантажити каталог. Перевірте інтернет і повторіть спробу.<br><button class="primary" type="button" data-action="reload">Спробувати ще раз</button></div>';
      feedback(error.message, "error");
    }
  }

  for (const container of [$("#grid"), $("#cartLines")]) container.addEventListener("click", event => {
    const button = event.target.closest("button[data-action]");
    if (!button || button.disabled) return;
    if (button.dataset.action === "reload") { void loadCatalog(); return; }
    changeCart(button.dataset.id, button.dataset.action === "increase" ? 1 : -1, button.dataset.action === "remove");
  });
  $("#search").addEventListener("input", renderCatalog);
  $("#ripening").addEventListener("change", renderCatalog);
  for (const id of ["color","kishmish"]) $("#"+id).addEventListener("change", renderCatalog);
  for (const id of ["priceMin","priceMax"]) $("#"+id).addEventListener("input", renderCatalog);
  $("#resetFilters").addEventListener("click", () => { for (const id of ["search","ripening","color","kishmish","priceMin","priceMax"]) $("#"+id).value = ""; renderCatalog(); });
  $("#openCart").addEventListener("click", openCart);
  $("#closeCart").addEventListener("click", closeCart);
  $("#toastCart").addEventListener("click", openCart);
  $("#toastClose").addEventListener("click", () => $("#toast").classList.remove("show"));
  $("#overlay").addEventListener("click", event => { if (event.target === $("#overlay")) closeCart(); });
  $("#overlay").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeCart(); }
    if (event.key !== "Tab") return;
    const focusable = [...$("#overlay").querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex="0"]')].filter(element => element.getClientRects().length);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  $("#storeRecoverButton").addEventListener("click", () => { void recover(); });
  $("#storeRefreshQuote").addEventListener("click", async () => { await loadCatalog(false); feedback(""); scheduleQuote(); });
  $("#storeContinue").addEventListener("click", () => {
    receiptShown = false; closeCart(); renderCart();
    void loadCatalog(false);
  });
  window.addEventListener("storage", event => {
    if (event.key !== CART_KEY || pending || inFlight) return;
    cart = readCart(); renderCatalog(); scheduleQuote();
  });

  updateControls();
  void (async () => {
    const result = await Promise.allSettled([loadCatalog(), api("/api/store/config", { signal: timeoutSignal(12000) })]);
    if (result[1].status === "fulfilled") {
      config = result[1].value;
      $("#storeDelivery").innerHTML = config.deliveryMethods.map(method => `<option value="${esc(method.id)}">${esc(method.name)}</option>`).join("");
      if ($("#overlay").classList.contains("show")) void mountTurnstile();
    }
    updateControls();
    if (pending) void recover(false);
  })();
})();
