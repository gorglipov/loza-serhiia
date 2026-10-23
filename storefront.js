(() => {
  "use strict";
  const $ = selector => document.querySelector(selector);
  const money = new Intl.NumberFormat("uk-UA", { style: "currency", currency: "UAH" });
  const price = kop => Number.isSafeInteger(kop) ? money.format(kop / 100) : "Ціну уточнюйте";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
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
      if (!item || !validId(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 5 || seen.has(item.productId) || seen.size >= 20) return false;
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
        ${quantity ? `<div class="quantity-control"><button type="button" data-action="decrease" data-id="${esc(product.id)}" aria-label="Зменшити кількість ${esc(product.name)}" ${pending ? "disabled" : ""}>−</button><span><strong>${quantity}</strong><small>у кошику</small></span><button type="button" data-action="increase" data-id="${esc(product.id)}" aria-label="Збільшити кількість ${esc(product.name)}" ${pending || !available || quantity >= 5 ? "disabled" : ""}>+</button></div>` :
          `<button class="add" type="button" data-action="increase" data-id="${esc(product.id)}" ${pending || !available ? "disabled" : ""}>${available ? "Додати до кошика" : product.priceKop === null ? "Замовлення недоступне" : !product.inStock ? "Замовлення недоступне" : !product.priceConfirmed ? "Ціна очікує підтвердження" : "Замовлення недоступне"}</button>`}
      </article>`;
    }).join("") : '<p class="store-load">За цими умовами товарів не знайдено.</p>';
    $("#varietySuggestions").innerHTML = query ? products.filter(product => product.name.toLocaleLowerCase("uk").startsWith(query)).slice(0, 10).map(product => `<option value="${esc(product.name)}"></option>`).join("") : "";
  }

  const paymentRadio = () => document.querySelector('input[name="paymentMode"]:checked');
  const expectedAdvanceKop = () => {
    const mode = paymentRadio()?.value;
    return Number.isSafeInteger(quoted?.amountKop) && mode
      ? (mode === "full" ? quoted.amountKop : 10000) : null;
  };
  const parseAmountKop = value => {
    const match = /^(\d{1,7})(?:[,.](\d{1,2}))?$/.exec(value.trim());
    return match ? Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0")) : null;
  };
  const proofFileValid = () => {
    const file = $("#storeProofFile").files[0];
    return Boolean(file && file.size >= 32 && file.size <= 600000 && ["image/jpeg", "image/png", "application/pdf"].includes(file.type));
  };
  const proofReady = () => Boolean(quoted?.manualTransferCard && expectedAdvanceKop() !== null &&
    parseAmountKop($("#storeReportedAmount").value) === expectedAdvanceKop() && proofFileValid());
  const readFileAsBase64 = file => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || !reader.result.includes(",")) reject(new Error("Не вдалося прочитати квитанцію."));
      else resolve(reader.result.slice(reader.result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Не вдалося прочитати квитанцію."));
    reader.readAsDataURL(file);
  });
  function renderPaymentBreakdown() {
    const total = Number.isSafeInteger(quoted?.amountKop) ? quoted.amountKop : null;
    const depositOption = document.querySelector('input[name="paymentMode"][value="deposit_cod"]');
    depositOption.disabled = total !== null && total < 10000;
    if (depositOption.disabled && depositOption.checked) depositOption.checked = false;
    const method = paymentRadio()?.value;
    $("#storePaymentTotal").textContent = total === null ? "—" : price(total);
    $("#storeAdvance").textContent = total === null || !method ? "—" : price(method === "full" ? total : 10000);
    $("#storeCod").textContent = total === null || !method ? "—" : price(method === "full" ? 0 : total - 10000);
    $("#storePaymentInfo").textContent = depositOption.disabled
      ? "Для замовлень менше 100 грн доступна лише повна передоплата."
      : method === "deposit_cod"
        ? "100 грн — погоджена передоплата; решта — післяплата при отриманні. Доставка й комісії не включені."
        : method === "full" ? "До оформлення переказуйте точну суму вартості товарів на картку."
        : "Оберіть умови оплати, щоб побачити розрахунок.";
    const transferReady = Boolean(quoted?.manualTransferCard && method && expectedAdvanceKop() !== null);
    $("#storePaymentProof").hidden = !transferReady;
    $("#storeReportedAmount").disabled = !transferReady;
    $("#storeProofFile").disabled = !transferReady;
    $("#storeCheckoutCard").textContent = transferReady ? quoted.manualTransferCard.replace(/(.{4})/g, "$1 ").trim() : "";
    $("#storeProofExpected").textContent = transferReady ? price(expectedAdvanceKop()) : "—";
    if (!quoted?.manualTransferCard && quoted && !quoteLoading) {
      $("#storePaymentInfo").textContent = "Реквізити для переказу недоступні. Замовлення зараз не оформлюється.";
    }
    const entered = parseAmountKop($("#storeReportedAmount").value);
    $("#storeProofStatus").textContent = !$("#storeReportedAmount").value.trim()
      ? "Вкажіть суму з квитанції та виберіть файл."
      : entered !== expectedAdvanceKop() ? `Сума не збігається. Для цього способу потрібно рівно ${price(expectedAdvanceKop())}.`
      : !proofFileValid() ? "Сума збігається. Прикріпіть JPG, PNG або PDF до 600 КБ."
      : "Сума збігається з кошиком, файл додано. Продавець перевірить чек і зарахування.";
  }
  document.querySelectorAll('input[name="paymentMode"]').forEach(input => input.addEventListener("change", () => { renderPaymentBreakdown(); updateControls(); }));
  for (const selector of ["#storeReportedAmount", "#storeProofFile"]) {
    $(selector).addEventListener(selector === "#storeProofFile" ? "change" : "input", updateControls);
  }
  $("#storeCopyCard").addEventListener("click", async () => {
    if (!quoted?.manualTransferCard) return;
    try {
      await navigator.clipboard.writeText(quoted.manualTransferCard);
      $("#storeCopyFeedback").textContent = "Номер картки скопійовано.";
    } catch { $("#storeCopyFeedback").textContent = "Не вдалося скопіювати автоматично. Виділіть номер картки вище."; }
  });

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
    renderPaymentBreakdown();
    $("#storeSubmit").disabled = inFlight || recovering || !config?.checkoutAvailable || !token || (!pendingPayload && (!quoted || quoteLoading || !paymentRadio() || !proofReady()));
    $("#storeSubmit").textContent = inFlight ? "Надсилаємо квитанцію…" : pending ? "Повторити надсилання" : "Підтвердити замовлення з квитанцією";
    $("#storeTotal").textContent = quoted ? price(quoted.amountKop) : quoteLoading ? "Розраховуємо…" : "—";
    $("#storeRefreshQuote").hidden = !cart.length || receiptShown || Boolean(quoted) || quoteLoading || Boolean(pending);
    $("#storeForm").setAttribute("aria-busy", String(inFlight));
  }

  function renderCart() {
    const byId = new Map((quoted?.lines || []).map(line => [line.productId, line]));
    $("#cartLines").innerHTML = cart.length ? cart.map(item => {
      const product = findProduct(item.productId), line = byId.get(item.productId);
      const unavailable = !product?.inStock || !product?.available || !product?.priceConfirmed;
      return `<div class="cartrow"><div><strong>${esc(product?.name || "Товар тимчасово недоступний")}</strong>
        <div class="hint">${esc(price(product?.priceKop))} за штуку</div>
        ${unavailable ? '<div class="store-stock store-unavailable">Наявність або ціна змінилася. Оновіть кошик.</div>' : ""}
        <div class="store-line-total">${line ? esc(price(line.lineTotalKop)) : quoteLoading ? "Розраховуємо…" : "—"}</div>
        <button class="remove" type="button" data-action="remove" data-id="${esc(item.productId)}" ${pending ? "disabled" : ""}>Прибрати</button></div>
        <div class="qty"><button type="button" data-action="decrease" data-id="${esc(item.productId)}" aria-label="Зменшити кількість ${esc(product?.name || "товару")}" ${pending ? "disabled" : ""}>−</button><output aria-label="Кількість">${item.quantity}</output><button type="button" data-action="increase" data-id="${esc(item.productId)}" aria-label="Збільшити кількість ${esc(product?.name || "товару")}" ${pending || !product?.available || item.quantity >= 5 ? "disabled" : ""}>+</button></div></div>`;
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
    if (next > current && (!product?.available || next > 5 || (!current && cart.length >= 20))) {
      toast("Не вдалося збільшити кількість", "До 5 штук кожного товару та до 20 різних товарів у кошику.");
      return;
    }
    cart = cart.filter(item => item.productId !== id);
    if (next > 0) cart.push({ productId: id, quantity: next });
    receiptShown = false;
    saveCart(); feedback(""); renderCatalog(); scheduleQuote();
    if (next > current) toast("Додано до кошика", product.name);
  }

  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileLoading) return turnstileLoading;
    turnstileLoading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => { script.remove(); turnstileLoading = null; reject(new Error("Не вдалося завантажити перевірку. Перевірте інтернет і відкрийте кошик знову.")); }, 15000);
      window.lozaTurnstileReady = () => { clearTimeout(timer); resolve(window.turnstile); };
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=lozaTurnstileReady";
      script.async = true;
      script.onerror = () => { clearTimeout(timer); script.remove(); turnstileLoading = null; reject(new Error("Перевірка недоступна. Перевірте інтернет і відкрийте кошик знову.")); };
      document.head.append(script);
    });
    return turnstileLoading;
  }

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
    const payment = data.payment || {};
    $("#storeReceiptPayment").textContent = payment.mode === "deposit_cod"
      ? "Обрано: 100 грн передоплати + " + price(payment.codKop) + " післяплатою. Оплата ще не підтверджена."
      : payment.mode === "full"
        ? "Обрано: повна передоплата " + price(payment.advanceKop) + ". Оплата ще не підтверджена."
        : "Умови оплати уточнюються з продавцем.";
    const transfer = data.manualTransfer;
    const transferValid = transfer &&
      typeof transfer.card === "string" && /^\d{16,19}$/.test(transfer.card) &&
      Number.isSafeInteger(transfer.amountKop) && transfer.amountKop > 0 &&
      transfer.amountKop === payment.advanceKop && transfer.reference === data.orderId &&
      data.testOnly !== true;
    $("#storeManualTransfer").hidden = !transferValid;
    $("#storeTransferCard").textContent = transferValid ? transfer.card.replace(/(.{4})/g, "$1 ").trim() : "";
    $("#storeTransferAmount").textContent = transferValid ? price(transfer.amountKop) : "";
    $("#storeTransferReference").textContent = transferValid ? transfer.reference : "";
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


  // Official Nova Poshta settlements and warehouse lists (no key is exposed to the browser).
  function setupNovaPoshtaAutocomplete() {
    const city = $("#storeCity"), branch = $("#storeBranch");
    const cityRef = $("#storeCityRef"), branchRef = $("#storeBranchRef");
    const cityStatus = $("#npCityStatus"), branchStatus = $("#npBranchStatus");

    function createLookup(input, list, status, type, onSelected) {
      let controller = null, timer = null, sequence = 0, options = [], active = -1;
      const close = () => { list.hidden = true; input.setAttribute("aria-expanded", "false"); active = -1; };
      const show = items => {
        options = items.slice(0, 15);
        list.replaceChildren();
        for (const [index, item] of options.entries()) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "np-option";
          button.setAttribute("role", "option");
          button.textContent = item.label;
          button.addEventListener("pointerdown", event => event.preventDefault());
          button.addEventListener("click", () => select(index));
          list.appendChild(button);
        }
        list.hidden = !options.length;
        input.setAttribute("aria-expanded", String(Boolean(options.length)));
        if (!options.length) status.textContent = "Немає збігів. Уточніть назву або номер.";
      };
      const select = index => {
        const item = options[index];
        if (!item) return;
        input.value = type === "settlements" ? item.description : item.label;
        onSelected(item);
        close();
      };
      async function load() {
        const seq = ++sequence;
        controller?.abort();
        const search = input.value.trim();
        if (type === "settlements" && !search) {
          close(); status.textContent = "Почніть вводити назву міста або села."; return;
        }
        if (type === "warehouses" && !cityRef.value) {
          close(); status.textContent = "Спочатку виберіть населений пункт зі списку."; return;
        }
        controller = new AbortController();
        status.textContent = "Шукаємо у довіднику Нової пошти…";
        const params = new URLSearchParams({ type, q: search });
        if (type === "warehouses") params.set("settlementRef", cityRef.value);
        try {
          const response = await fetch("/api/np?" + params, {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
          });
          const result = await response.json();
          if (!response.ok || !result.ok || !Array.isArray(result.data)) {
            throw new Error(result.error || "Довідник тимчасово недоступний.");
          }
          if (seq !== sequence || search !== input.value.trim()) return;
          show(result.data);
          if (options.length) status.textContent = "Виберіть варіант зі списку.";
        } catch (error) {
          if (error.name === "AbortError" || seq !== sequence) return;
          close(); status.textContent = error.message || "Не вдалося отримати довідник.";
          status.classList.add("error");
        }
      }
      const schedule = (delay = 250) => {
        clearTimeout(timer);
        controller?.abort();
        sequence++;
        status.classList.remove("error");
        timer = setTimeout(() => { void load(); }, delay);
      };
      input.addEventListener("focus", () => schedule(0));
      input.addEventListener("keydown", event => {
        if (event.key === "Escape") { close(); return; }
        if (list.hidden || !options.length) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          active = event.key === "ArrowDown" ? (active + 1) % options.length : (active + options.length - 1) % options.length;
          [...list.children].forEach((button, index) => { button.style.background = index === active ? "#edf3e9" : ""; });
        }
        if (event.key === "Enter" && active >= 0) { event.preventDefault(); select(active); }
      });
      input.addEventListener("blur", () => setTimeout(close, 180));
      return { schedule, close, cancel: () => { clearTimeout(timer); controller?.abort(); sequence++; close(); } };
    }

    const branchLookup = createLookup(branch, $("#npBranchOptions"), branchStatus, "warehouses", item => {
      branchRef.value = item.ref;
      branchStatus.textContent = "Відділення вибрано.";
    });
    const cityLookup = createLookup(city, $("#npCityOptions"), cityStatus, "settlements", item => {
      cityRef.value = item.ref;
      branch.value = ""; branchRef.value = ""; branch.disabled = false;
      branch.placeholder = "Введіть номер або назву відділення";
      branchStatus.textContent = "Натисніть на поле, щоб переглянути відділення.";
      branchLookup.cancel();
    });
    city.addEventListener("input", () => {
      cityRef.value = ""; branchRef.value = ""; branch.value = ""; branch.disabled = true;
      branchLookup.cancel(); cityLookup.schedule();
    });
    branch.addEventListener("input", () => { branchRef.value = ""; branchLookup.schedule(); });
    $("#storeForm").addEventListener("reset", () => {
      cityLookup.cancel(); branchLookup.cancel();
      cityRef.value = ""; branchRef.value = ""; branch.disabled = true;
      cityStatus.textContent = "Оберіть населений пункт зі списку Нової пошти.";
      branchStatus.textContent = "Список відділень з'явиться після вибору міста або села.";
    });
  }
  setupNovaPoshtaAutocomplete();

  $("#storeForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (inFlight || recovering || receiptShown) return;
    if (!$("#storeForm").reportValidity()) return;
    if (!paymentRadio()) { feedback("Оберіть умови оплати.", "error"); return; }
    if (!pendingPayload && (!$("#storeCityRef").value || !$("#storeBranchRef").value)) {
      feedback("Оберіть місто або село та відділення зі списків Нової пошти.", "error");
      (!$("#storeCityRef").value ? $("#storeCity") : $("#storeBranch")).focus();
      return;
    }
    if (!token) { feedback("Пройдіть перевірку перед надсиланням.", "error"); return; }
    if (!pending && (!quoted || quoteLoading || !cart.length)) { feedback("Дочекайтеся розрахунку кошика.", "error"); return; }
    if (!pendingPayload && !proofReady()) { feedback("Додайте квитанцію та вкажіть точну суму передоплати.", "error"); return; }
    inFlight = true; feedback("Надсилаємо квитанцію й створюємо замовлення…"); updateControls();
    try {
      const file = $("#storeProofFile").files[0];
      const input = pendingPayload || {
        items: pending ? pending.items : cart.map(item => ({ ...item })),
        customer: { name: $("#storeBuyer").value.trim(), phone: $("#storePhone").value.trim() },
        delivery: { city: $("#storeCity").value.trim(), method: $("#storeDelivery").value, branch: $("#storeBranch").value.trim() },
        comment: $("#storeComment").value.trim(),
        payment: {
          mode: paymentRadio()?.value || "",
          reportedAmountKop: parseAmountKop($("#storeReportedAmount").value),
          proof: { mimeType: file?.type, dataBase64: await readFileAsBase64(file) },
        },
      };
      pending ||= { key: makeKey(), items: input.items.map(item => ({ ...item })) };
      pendingPayload = input;
      savePending(); renderCatalog(); renderCart();
      const result = await api("/api/orders/create", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": pending.key }, body: JSON.stringify({ ...input, turnstileToken: token }), signal: timeoutSignal(25000) });
      showReceipt(result, input.items);
    } catch (error) {
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        pendingPayload = null;
        feedback("Попередній запит уже прийнято. Натисніть «Перевірити попередній запит».", "error");
      } else if (["INVALID_DETAILS", "INVALID_ITEMS", "INVALID_BODY", "INVALID_FORMAT", "INVALID_KEY", "INVALID_PAYMENT_PROOF", "BODY_TOO_LARGE", "STOCK_UNAVAILABLE", "FORBIDDEN"].includes(error.code)) {
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
      // Only Nova Poshta is supported; delivery is a fixed hidden field.
      if ($("#overlay").classList.contains("show")) void mountTurnstile();
    }
    updateControls();
    if (pending) void recover(false);
  })();
})();
